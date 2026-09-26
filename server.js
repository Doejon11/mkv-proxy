const express = require('express');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 10000;
const API_SECRET_KEY = 'Chuoi_Bao_Mat_VR_123';
const SEGMENT_DURATION = 6; // giây mỗi segment HLS

const HEADERS = 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36\r\nAccept: */*\r\nConnection: keep-alive';

// Cache thông tin file (duration, codec, số kênh audio) để khỏi ffprobe lại mỗi lần
const infoCache = new Map();

function checkKey(req, res) {
    if (req.query.key !== API_SECRET_KEY) {
        res.status(403).send('403 Forbidden: Key sai');
        return false;
    }
    return true;
}

// Lấy duration + thông tin audio track (codec, số kênh) bằng 1 lần ffprobe
function probeMedia(videoUrl, audioTrackIndex) {
    return new Promise((resolve, reject) => {
        const cacheKey = `${videoUrl}#${audioTrackIndex}`;
        if (infoCache.has(cacheKey)) return resolve(infoCache.get(cacheKey));

        const args = [
            '-headers', HEADERS,
            '-v', 'error',
            '-show_entries', 'format=duration:stream=index,codec_type,codec_name,channels',
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

                const info = {
                    duration,
                    audioCodec: chosen ? chosen.codec_name : null,
                    channels: chosen ? (chosen.channels || 2) : 2
                };
                infoCache.set(cacheKey, info);
                resolve(info);
            } catch (e) {
                reject(e);
            }
        });
    });
}

// Chọn bitrate AAC theo số kênh, đảm bảo chất lượng tương đương nguồn
function bitrateForChannels(channels) {
    if (channels >= 8) return '640k';   // 7.1
    if (channels >= 6) return '448k';   // 5.1
    if (channels >= 3) return '256k';   // 3.x/quad hiếm gặp
    return '192k';                       // stereo/mono
}

app.get('/', (req, res) => {
    res.send('HLS Audio-Transcode Proxy đang hoạt động!');
});

// Sinh playlist HLS (VOD) — client tua bằng cách nhảy segment
app.get('/playlist.m3u8', async (req, res) => {
    if (!checkKey(req, res)) return;

    const videoUrl = decodeURIComponent(req.query.url || '');
    if (!videoUrl) return res.status(400).send('400 Bad Request: Thiếu url');
    const audioTrack = parseInt(req.query.audio || '0', 10);

    try {
        const info = await probeMedia(videoUrl, audioTrack);
        const numSegments = Math.ceil(info.duration / SEGMENT_DURATION);

        let m3u8 = '#EXTM3U\n#EXT-X-VERSION:3\n';
        m3u8 += `#EXT-X-TARGETDURATION:${SEGMENT_DURATION}\n`;
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

// Sinh từng segment .ts theo yêu cầu
app.get('/segment', async (req, res) => {
    if (!checkKey(req, res)) return;

    const videoUrl = decodeURIComponent(req.query.url || '');
    if (!videoUrl) return res.status(400).send('400 Bad Request: Thiếu url');
    const audioTrack = parseInt(req.query.audio || '0', 10);
    const index = parseInt(req.query.index, 10);
    if (isNaN(index)) return res.status(400).send('400 Bad Request: Thiếu index');

    const startTime = index * SEGMENT_DURATION;

    let audioArgs;
    try {
        const info = await probeMedia(videoUrl, audioTrack);
        if (info.audioCodec === 'aac') {
            // Nguồn đã là AAC -> copy thẳng, khỏi tốn CPU encode lại
            audioArgs = ['-c:a', 'copy'];
        } else {
            // Mọi codec khác (ac3, eac3, dts, truehd, mp3, ...) -> transcode sang AAC, giữ nguyên số kênh
            audioArgs = ['-c:a', 'aac', '-b:a', bitrateForChannels(info.channels)];
        }
        console.log(`>>> Segment ${index}: audioCodec=${info.audioCodec}, channels=${info.channels}`);
    } catch (e) {
        console.error('>>> Lỗi probe segment, fallback transcode mặc định:', e.message);
        audioArgs = ['-c:a', 'aac', '-b:a', '448k'];
    }

    const args = [
        '-headers', HEADERS,
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

    ffmpegProc.stderr.on('data', (data) => {
        console.error(`>>> FFmpeg[seg${index}]:`, data.toString().trim());
    });

    ffmpegProc.on('error', (err) => {
        console.error('>>> FFmpeg spawn error:', err);
        if (!res.headersSent) res.status(500).end();
    });

    ffmpegProc.on('close', (code) => {
        if (code !== 0 && code !== null) {
            console.log(`>>> FFmpeg[seg${index}] exited code: ${code}`);
        }
    });

    req.on('close', () => {
        ffmpegProc.kill('SIGKILL');
    });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
