const express = require('express');
const ytdl = require('@distube/ytdl-core');
const path = require('path');
const app = express();

// Serve static files from the public folder
app.use(express.static('public'));

app.get('/info', async (req, res) => {
  const { url } = req.query;
  
  try {
    const info = await ytdl.getInfo(url);
    res.json({ info });
  } catch (error) {
    res.status(400).json({ error: 'Invalid URL or unable to fetch information' });
  }
});

app.get('/download', async (req, res) => {
  const { url, format } = req.query;
  
  try {
    const info = await ytdl.getInfo(url);
    const title = info.videoDetails.title.replace(/[^\w\s]/gi, '');
    
    res.header('Content-Disposition', `attachment; filename="${title}.${format === 'mp3' ? 'mp3' : 'mp4'}"`);
    
    if (format === 'mp3') {
      ytdl(url, { filter: 'audioonly' }).pipe(res);
    } else if (format === '360p') {
      ytdl(url, { quality: '18' }).pipe(res);
    } else if (format === '480p') {
      ytdl(url, { quality: '135' }).pipe(res);
    } else if (format === '720p') {
      ytdl(url, { quality: '22' }).pipe(res);
    } else if (format === '1080p') {
      ytdl(url, { quality: '137' }).pipe(res);
    } else {
      ytdl(url, { quality: 'highest' }).pipe(res);
    }
  } catch (error) {
    res.status(400).send('Error downloading video');
  }
});

app.listen(3000, () => console.log('Running On http://localhost:3000'));