const express = require('express');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 10000;
const API_SECRET_KEY = 'Chuoi_Bao_Mat_VR_123';
const SEGMENT_DURATION = 8;

const HEADERS = 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36\r\nAccept: */*\r\nConnection: keep-alive';

const infoCache = new Map();
// Đảm bảo chỉ 1 kết nối tới TorBox tồn tại tại 1 thời điểm cho mỗi video,
// tránh bị CDN coi là mở nhiều kết nối đồng thời -> throttle/520.
const activeConnByKey = new Map(); // key: videoUrl#audio -> ffmpeg process hiện tại

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

// Đóng hẳn kết nối cũ (nếu có) tới TorBox cho cùng video, và chờ 1 nhịp ngắn
// để CDN kịp nhận biết kết nối đã đóng trước khi mở kết nối mới.
function closeActiveConnection(key) {
    return new Promise((resolve) => {
        const prev = activeConnByKey.get(key);
        if (!prev) return resolve();

        console.log(`>>> Đóng kết nối cũ tới TorBox cho key=${key} trước khi mở kết nối mới`);
        prev.kill('SIGKILL');
        activeConnByKey.delete(key);
        setTimeout(resolve, 400); // nhịp nghỉ để CDN nhận biết connection đã đóng
    });
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

    const connKey = `${videoUrl}#${audioTrack}`;
    const startTime = index * SEGMENT_DURATION;

    // Đảm bảo không có 2 kết nối tới TorBox cùng lúc cho cùng video
    await closeActiveConnection(connKey);

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
        console.log(`>>> Segment ${index}: start=${startTime}s, audioTrack=${audioTrack}, codec=${info.audioCodec}, channels=${info.channels}`);
    } catch (e) {
        console.error('>>> Lỗi probe segment, fallback transcode mặc định:', e.message);
        audioArgs = ['-c:a', 'aac', '-b:a', '448k', '-channel_layout', '5.1'];
    }

    const args = [
        '-headers', HEADERS,
        '-noaccurate_seek',
        '-ss', String(startTime),
        '-reconnect', '1',
        '-reconnect_delay_max', '10',
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
    activeConnByKey.set(connKey, ffmpegProc);

    ffmpegProc.stdout.pipe(res);

    ffmpegProc.stderr.on('data', (data) => {
        console.error(`>>> FFmpeg[seg${index}]:`, data.toString().trim());
    });

    ffmpegProc.on('error', (err) => {
        console.error('>>> FFmpeg spawn error:', err);
        if (!res.headersSent) res.status(500).end();
    });

    ffmpegProc.on('close', (code) => {
        if (activeConnByKey.get(connKey) === ffmpegProc) {
            activeConnByKey.delete(connKey);
        }
        if (code !== 0 && code !== null) {
            console.log(`>>> FFmpeg[seg${index}] exited code: ${code}`);
        }
    });

    req.on('close', () => {
        if (activeConnByKey.get(connKey) === ffmpegProc) {
            activeConnByKey.delete(connKey);
        }
        ffmpegProc.kill('SIGKILL');
    });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
