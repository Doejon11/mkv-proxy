const express = require('express');
const ffmpeg = require('fluent-ffmpeg');

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

    console.log('>>> Processing URL:', videoUrl);

    try {
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Accept-Ranges', 'bytes');

        ffmpeg(videoUrl)
            .inputOptions([
                '-user_agent', '"Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0"',
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '5'
            ])
            .outputOptions([
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
                '-movflags', 'frag_keyframe+empty_moov+default_base_moov'
            ])
            .on('start', (cmd) => {
                console.log('>>> FFmpeg Command Running:', cmd);
            })
            .on('error', (err) => {
                if (err.message.includes('Output pipe closed')) return;
                console.error('>>> FFmpeg Error:', err.message);
            })
            .pipe(res, { end: true });

    } catch (error) {
        console.error('>>> Server Error:', error.message);
        if (!res.headersSent) res.status(500).send('Server Error');
    }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
