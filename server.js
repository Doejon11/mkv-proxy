const express = require('express');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 10000;
const API_SECRET_KEY = 'Chuoi_Bao_Mat_VR_123';

const HEADERS = 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36\r\nAccept: */*\r\nConnection: keep-alive';

const infoCache = new Map();     // cache thông tin audio track theo videoUrl#audioTrack
const durationCache = new Map(); // cache duration theo videoUrl

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

// Lấy thông tin audio track (codec, số kênh, layout) — dùng cho việc quyết định có cần convert hay không
function probeAudioInfo(videoUrl, audioTrackIndex) {
    return new Promise((resolve, reject) => {
        const cacheKey = `${videoUrl}#${audioTrackIndex}`;
        if (infoCache.has(cacheKey)) return resolve(infoCache.get(cacheKey));

        const args = [
            '-headers', HEADERS,
            '-v', 'error',
            '-show_entries', 'stream=codec_type,codec_name,channels,channel_layout',
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
                const audioStreams = (data.streams || []).filter(s => s.codec_type === 'audio');
                const chosen = audioStreams[audioTrackIndex] || audioStreams[0];
                const channels = chosen ? (chosen.channels || 2) : 2;

                const info = {
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

// Lấy tổng thời lượng file — dùng cho việc set max giá trị của Slider bên Unity
function probeDuration(videoUrl) {
    return new Promise((resolve, reject) => {
        if (durationCache.has(videoUrl)) return resolve(durationCache.get(videoUrl));

        const args = [
            '-headers', HEADERS,
            '-v', 'error',
            '-show_entries', 'format=duration',
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
                durationCache.set(videoUrl, duration);
                resolve(duration);
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

app.get('/', (req, res) => {
    res.send('MKV Proxy Server đang hoạt động!');
});

// Lấy tổng thời lượng phim — Unity gọi 1 lần khi bắt đầu phát để set max cho Slider
app.get('/info', async (req, res) => {
    if (!checkKey(req, res)) return;

    const videoUrl = extractParam(req.url, 'url');
    if (!videoUrl) return res.status(400).send('400 Bad Request: Thiếu url');

    try {
        const duration = await probeDuration(videoUrl);
        res.json({ duration });
    } catch (e) {
        console.error('>>> Lỗi /info:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Stream chính — vừa dùng để phát ban đầu, vừa dùng để tua (gọi lại với ss mới)
app.get('/stream', async (req, res) => {
    if (!checkKey(req, res)) return;

    const videoUrl = extractParam(req.url, 'url');
    if (!videoUrl) return res.status(400).send('400 Bad Request: Thiếu url');
    const audioTrack = parseInt(req.query.audio || '0', 10);
    const startTime = req.query.ss || '0';

    console.log(`>>> Stream request: audio=${audioTrack}, ss=${startTime}`);

    let audioArgs;
    try {
        const info = await probeAudioInfo(videoUrl, audioTrack);
        if (info.audioCodec === 'aac') {
            audioArgs = ['-c:a', 'copy'];
        } else {
            audioArgs = [
                '-c:a', 'aac',
                '-b:a', bitrateForChannels(info.channels),
                '-channel_layout', info.channelLayout   // fix lỗi PCE khiến Android không giải mã được audio đa kênh
            ];
        }
        console.log(`>>> Audio track ${audioTrack}: codec=${info.audioCodec}, channels=${info.channels}, layout=${info.channelLayout}`);
    } catch (e) {
        console.error('>>> Lỗi probe audio, fallback transcode mặc định:', e.message);
        audioArgs = ['-c:a', 'aac', '-b:a', '448k', '-channel_layout', '5.1'];
    }

    const args = [
        '-headers', HEADERS,
        '-ss', startTime,
        '-reconnect', '1',
        '-reconnect_delay_max', '5',
        '-i', videoUrl,
        '-map', '0:v:0',
        '-map', `0:a:${audioTrack}?`,
        '-sn', '-dn',
        '-c:v', 'copy',              // giữ nguyên video, không convert
        ...audioArgs,                 // chỉ convert audio sang AAC, giữ nguyên số kênh
        '-f', 'mp4',
        '-movflags', 'frag_keyframe+empty_moov',
        '-frag_duration', '1000000',
        'pipe:1'
    ];

    res.setHeader('Content-Type', 'video/mp4');

    const ffmpegProc = spawn('ffmpeg', args);
    ffmpegProc.stdout.pipe(res);

    ffmpegProc.stderr.on('data', (data) => {
        const msg = data.toString();
        if (msg.includes('Error') || msg.includes('error') || msg.includes('failed')) {
            console.error('>>> FFmpeg:', msg.trim());
        }
    });

    ffmpegProc.on('error', (err) => {
        console.error('>>> FFmpeg spawn error:', err);
        if (!res.headersSent) res.status(500).end();
    });

    ffmpegProc.on('close', (code) => {
        if (code !== 0 && code !== null) {
            console.log(`>>> FFmpeg exited code: ${code}`);
        }
    });

    req.on('close', () => {
        ffmpegProc.kill('SIGKILL');
    });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
