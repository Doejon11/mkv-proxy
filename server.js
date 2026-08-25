const express = require('express');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 10000;
const API_SECRET_KEY = 'Chuoi_Bao_Mat_VR_123';

app.get('/', (req, res) => {
    res.send('MKV Proxy Server đang hoạt động!');
});

app.get('/stream', (req, res) => {
    const clientKey = req.query.key;
    if (!clientKey || clientKey !== API_SECRET_KEY) {
        return res.status(403).send('403 Forbidden: Key sai');
    }

    const rawReqUrl = req.url;
    const urlMatch = rawReqUrl.match(/[?&]url=([^&]+)/);
    if (!urlMatch || !urlMatch[1]) {
        return res.status(400).send('400 Bad Request: Thiếu URL');
    }

    let videoUrl = decodeURIComponent(urlMatch[1]);
    if (videoUrl.includes('%3F') || videoUrl.includes('%3D')) {
        videoUrl = decodeURIComponent(videoUrl);
    }

    console.log('>>> Processing Stream URL:', videoUrl);

    const headers = 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36\r\nAccept: */*\r\nConnection: keep-alive';

    // Cấu hình FFmpeg Stream chuẩn hóa cho Pipe
    const args = [
        '-headers', headers,
        '-reconnect', '1',
        '-reconnect_streamed', '1',
        '-reconnect_delay_max', '5',
        '-i', videoUrl,
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-sn',
        '-dn',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-ar', '44100',
        '-ac', '2',
        '-b:a', '192k',
        '-f', 'mp4',
        '-movflags', 'frag_keyframe+empty_moov',
        '-frag_duration', '1000000', // Cắt nhỏ gói tin mỗi 1 giây để stream mượt
        'pipe:1'
    ];

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');

    const ffmpegProc = spawn('ffmpeg', args);

    ffmpegProc.stdout.pipe(res);

    ffmpegProc.stderr.on('data', (data) => {
        const msg = data.toString();
        if (msg.includes('Error') || msg.includes('Server returned') || msg.includes('failed')) {
            console.error('>>> FFmpeg Log:', msg.trim());
        }
    });

    ffmpegProc.on('close', (code) => {
        if (code !== 0 && code !== null) {
            console.log(`>>> FFmpeg Exited with code: ${code}`);
        }
    });

    req.on('close', () => {
        ffmpegProc.kill('SIGKILL');
    });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
