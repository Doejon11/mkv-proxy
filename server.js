const express = require('express');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 10000;
const API_SECRET_KEY = 'Chuoi_Bao_Mat_VR_123';
const SEGMENT_DURATION = 14; // giây mỗi segment HLS (nominal, dùng để khai báo playlist)

const HEADERS = 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36\r\nAccept: */*\r\nConnection: keep-alive';

const infoCache = new Map();
const segmentLedger = new Map();     // key: videoUrl#audio -> [{start, duration}, ...]
const inFlightSegments = new Map();  // key: videoUrl#audio#index -> true khi đang xử lý

function getLedger(key) {
    if (!segmentLedger.has(key)) segmentLedger.set(key, []);
    return segmentLedger.get(key);
}

function extractParam(reqUrl, paramName) {
    const regex = new RegExp(`[?&]${paramName}=([^&]+)`);
    const match = reqUrl.match(regex);
    if (!match || !match[1]) return null;

    let value = decodeURIComponent(match[1]);
    if (value.includes('%3F') || value.includes('%3D') || value.includes('%26') || value.includes('%3A')) {
        value = decodeURIComponent(value);
    }
    return value;
}

function checkKey(req, res) {
    if (req.query.key !== API_SECRET_KEY) {
        res.status(403).send('403 Forbidden: Key sai');
        return false;
    }
    return true;
}

function noCache(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
}

function normalizeChannelLayout(rawLayout, channels) {
    if (rawLayout) {
        const cleaned = rawLayout.replace(/\s*\([^)]*\)\s*/g, '').trim();
        if (cleaned) return cleaned;
    }
    if (channels >= 8) return '7.1';
    if (channels >= 6) return '5.1';
    if (channels === 1) return 'mono';
    return 'stereo';
}

function probeMedia(videoUrl, audioTrackIndex) {
    return new Promise((resolve, reject) => {
        const cacheKey = `${videoUrl}#${audioTrackIndex}`;
        if (infoCache.has(cacheKey)) return resolve(infoCache.get(cacheKey));

        const args = [
            '-headers', HEADERS,
            '-v', 'error',
            '-show_entries', 'format=duration:stream=index,codec_type,codec_name,channels,channel_layout',
            '-of', 'json',
            videoUrl
        ];

        const probe = spawn('ffprobe', args);
        let out = '';
        let err = '';
        probe.stdout.on('data', d => out += d);
        probe.stderr.on('data', d => err += d);

        probe.on('close', (code) => {
            if (code !== 0) return reject(new Error('ffprobe lỗi: ' + err));
            try {
                const data = JSON.parse(out);
                const duration = parseFloat(data.format.duration);
                if (!duration) return reject(new Error('Không lấy được duration'));

                const audioStreams = (data.streams || []).filter(s => s.codec_type === 'audio');
                const chosen = audioStreams[audioTrackIndex] || audioStreams[0];

                const channels = chosen ? (chosen.channels || 2) : 2;
                const info = {
                    duration,
                    audioCodec: chosen ? chosen.codec_name : null,
                    channels,
                    channelLayout: normalizeChannelLayout(chosen ? chosen.channel_layout : null, channels)
                };
                infoCache.set(cacheKey, info);
                resolve(info);
            } catch (e) {
                reject(e);
            }
        });

        probe.on('error', (e) => reject(e));
    });
}

function bitrateForChannels(channels) {
    if (channels >= 8) return '640k';
    if (channels >= 6) return '448k';
    if (channels >= 3) return '256k';
    return '192k';
}

function parseActualDuration(stderrText, fallback) {
    const matches = [...stderrText.matchAll(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/g)];
    if (matches.length === 0) return fallback;
    const last = matches[matches.length - 1];
    const h = parseInt(last[1], 10);
    const m = parseInt(last[2], 10);
    const s = parseFloat(last[3]);
    return h * 3600 + m * 60 + s;
}

app.get('/', (req, res) => {
    res.send('HLS Audio-Transcode Proxy đang hoạt động!');
});

app.get('/playlist.m3u8', async (req, res) => {
    if (!checkKey(req, res)) return;
    noCache(res);

    const videoUrl = extractParam(req.url, 'url');
    if (!videoUrl) return res.status(400).send('400 Bad Request: Thiếu url');
    const audioTrack = parseInt(req.query.audio || '0', 10);

    console.log('>>> [playlist] Final videoUrl:', videoUrl);
    console.log('>>> [playlist] audioTrack requested:', req.query.audio, '-> parsed:', audioTrack);

    try {
        const info = await probeMedia(videoUrl, audioTrack);
        const numSegments = Math.ceil(info.duration / SEGMENT_DURATION);

        let m3u8 = '#EXTM3U\n#EXT-X-VERSION:3\n';
        m3u8 += `#EXT-X-TARGETDURATION:${SEGMENT_DURATION + 2}\n`;
        m3u8 += '#EXT-X-PLAYLIST-TYPE:VOD\n';
        m3u8 += '#EXT-X-MEDIA-SEQUENCE:0\n';

        for (let i = 0; i < numSegments; i++) {
            const segDur = Math.min(SEGMENT_DURATION, info.duration - i * SEGMENT_DURATION);
            m3u8 += `#EXTINF:${segDur.toFixed(3)},\n`;
            m3u8 += `/segment?url=${encodeURIComponent(videoUrl)}&audio=${audioTrack}&index=${i}&key=${API_SECRET_KEY}\n`;
        }
        m3u8 += '#EXT-X-ENDLIST\n';

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(m3u8);
    } catch (e) {
        console.error('>>> Lỗi playlist:', e.message);
        res.status(500).send('Lỗi lấy thông tin media: ' + e.message);
    }
});

app.get('/segment', async (req, res) => {
    if (!checkKey(req, res)) return;
    noCache(res);

    const videoUrl = extractParam(req.url, 'url');
    if (!videoUrl) return res.status(400).send('400 Bad Request: Thiếu url');
    const audioTrack = parseInt(req.query.audio || '0', 10);
    const index = parseInt(req.query.index, 10);
    if (isNaN(index)) return res.status(400).send('400 Bad Request: Thiếu index');

    const ledgerKey = `${videoUrl}#${audioTrack}`;
    const segKey = `${videoUrl}#${audioTrack}#${index}`;
    const ledger = getLedger(ledgerKey);

    // Chống trùng lặp: nếu segment này đang có 1 tiến trình ffmpeg xử lý,
    // từ chối request trùng thay vì spawn thêm 1 tiến trình nữa tranh CPU.
    if (inFlightSegments.has(segKey)) {
        console.log(`>>> Segment ${index} đang được xử lý, bỏ qua request trùng`);
        return res.status(409).end();
    }
    inFlightSegments.set(segKey, true);

    let startTime;
    if (ledger[index - 1]) {
        startTime = ledger[index - 1].start + ledger[index - 1].duration;
    } else {
        startTime = index * SEGMENT_DURATION;
    }

    let audioArgs;
    try {
        const info = await probeMedia(videoUrl, audioTrack);
        if (info.audioCodec === 'aac') {
            audioArgs = ['-c:a', 'copy'];
        } else {
            audioArgs = [
                '-c:a', 'aac',
                '-b:a', bitrateForChannels(info.channels),
                '-channel_layout', info.channelLayout
            ];
        }
        console.log(`>>> Segment ${index}: start=${startTime.toFixed(2)}s, audioTrack=${audioTrack}, codec=${info.audioCodec}, channels=${info.channels}`);
    } catch (e) {
        console.error('>>> Lỗi probe segment, fallback transcode mặc định:', e.message);
        audioArgs = ['-c:a', 'aac', '-b:a', '448k', '-channel_layout', '5.1'];
    }

    const args = [
        '-headers', HEADERS,
        '-noaccurate_seek',
        '-ss', String(startTime),
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-i', videoUrl,
        '-t', String(SEGMENT_DURATION),
        '-map', '0:v:0',
        '-map', `0:a:${audioTrack}?`,
        '-sn', '-dn',
        '-c:v', 'copy',
        ...audioArgs,
        '-f', 'mpegts',
        '-avoid_negative_ts', 'make_zero',
        'pipe:1'
    ];

    res.setHeader('Content-Type', 'video/MP2T');

    const ffmpegProc = spawn('ffmpeg', args);
    ffmpegProc.stdout.pipe(res);

    let stderrBuffer = '';
    let cleaned = false;
    const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        inFlightSegments.delete(segKey);
    };

    ffmpegProc.stderr.on('data', (data) => {
        const text = data.toString();
        stderrBuffer += text;
        console.error(`>>> FFmpeg[seg${index}]:`, text.trim());
    });

    ffmpegProc.on('error', (err) => {
        console.error('>>> FFmpeg spawn error:', err);
        cleanup();
        if (!res.headersSent) res.status(500).end();
    });

    ffmpegProc.on('close', (code) => {
        if (code !== 0 && code !== null) {
            console.log(`>>> FFmpeg[seg${index}] exited code: ${code}`);
        }
        const actualDuration = parseActualDuration(stderrBuffer, SEGMENT_DURATION);
        ledger[index] = { start: startTime, duration: actualDuration };
        cleanup();
    });

    req.on('close', () => {
        ffmpegProc.kill('SIGKILL');
        cleanup();
    });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
