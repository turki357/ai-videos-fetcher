const admin = require('firebase-admin');
const axios = require('axios');
const { format } = require('date-fns');

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const MAX_DAILY_VIDEOS = 40;
const TARGET_HOUR = 18;
const REQUEST_DELAY = 1500;

const CHANNELS = [
'UC95qm5Xg8AOFPQajjriO4CA', // Barhom m3arawi
'UCJdIPJrFvh2KbnbX4U9ILhA', // Otmane El Atmani Reaction
'UCtFXLjeUk7lJ9eN0KAxqn1w', // Yehiaradwan
'UCqe0sSESmaQbLFdTExctQLA', // Marodi TV Sénégal
'UCvC4D8onUfXzvjTOM-dBfEA', // Marvel Entertainment
'UCRE-097LGtx_Zo7LrHvkycA', // JISOO
'UCPNxhDvTcytIdvwXWAm43cA', // Selena Gomez
'UCl3F2QfnlJj3BCYhbbG4wqg', // RESPECT 1M
'UCq9TsFbtNkfRiKa7YxKEorw', // FaizaEditz
'UCe9qomDawkYpuPyG6prIfCg', // ZAMAN
'UCp41n_WUDdvC2qu20MsmYng', // isaacsamz
'UC5NEWyJDtr8vtzJWT6SXK4Q', // Eternal Love
'UCZTGFkS7f-6NqCw66-Rj2Ag', // Drama Subho
'UC45w2hxRWSdVPUHZXNl_CuQ', // ahmed elghnam
'UCa4BGN_3s2xW3rci_v6Nphw', // BTS ARMY
'UCJhlFKSRaF483kPayLjovyA', // C11kp
'UC-MeFI2sQpSoi0zxavR5dLw'  // Viral Vision HD
];

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
});
const db = admin.firestore();

const channelCache = new Map();

async function fetchVideos() {
    try {
        if (!isRightTime()) {
            console.log('⏳ Not the scheduled time (6 PM Morocco)');
            return;
        }

        if (await isDailyLimitReached()) {
            console.log(`🎯 Daily limit reached (${MAX_DAILY_VIDEOS} videos)`);
            return;
        }

        const videos = await fetchAllVideos();
        
        if (videos.length > 0) {
            await saveVideos(videos);
            console.log(
                `✅ Added ${videos.length} videos\n` +
                `📊 Quota used: ${calculateQuota(videos.length)} units\n` +
                `⏰ ${format(new Date(), 'yyyy-MM-dd HH:mm')}`
            );
        } else {
            console.log('⚠️ No new videos found today');
        }

        await logExecution(videos.length);

    } catch (error) {
        console.error('❌ Main error:', error);
        await logError(error);
        process.exit(0);
    }
}

function isRightTime() {
    const now = new Date();
    const moroccoTime = new Date(now.toLocaleString('en-US', { timeZone: 'Africa/Casablanca' }));
    return moroccoTime.getHours() === TARGET_HOUR;
}

async function isDailyLimitReached() {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const snapshot = await db.collection('videos')
        .where('timestamp', '>=', todayStart)
        .count()
        .get();

    return snapshot.data().count >= MAX_DAILY_VIDEOS;
}

async function fetchAllVideos() {
    const videos = [];
    
    for (const channelId of CHANNELS) {
        try {
            await delay(REQUEST_DELAY);
            const video = await fetchChannelVideo(channelId);
            if (video) videos.push(video);
        } catch (error) {
            console.error(`❌ ${channelId}:`, error.message);
        }
    }
    
    return videos;
}

async function fetchChannelVideo(channelId) {
    const videoId = await getLatestVideoId(channelId);
    if (!videoId) return null;

    if (await isVideoExists(videoId)) {
        console.log(`⏭️ Skipping existing video: ${videoId}`);
        return null;
    }

    return await getVideoDetails(videoId);
}

async function getLatestVideoId(channelId) {
    const response = await axios.get(
        `https://www.googleapis.com/youtube/v3/search?key=${YOUTUBE_API_KEY}` +
        `&channelId=${channelId}&part=snippet&order=date` +
        `&maxResults=1&type=video&videoDuration=short` +
        `&fields=items(id(videoId))`
    );

    return response.data.items[0]?.id.videoId;
}

async function isVideoExists(videoId) {
    const doc = await db.collection('videos').doc(videoId).get();
    return doc.exists;
}

async function getVideoDetails(videoId) {
    const response = await axios.get(
        `https://www.googleapis.com/youtube/v3/videos?key=${YOUTUBE_API_KEY}` +
        `&id=${videoId}&part=snippet,contentDetails,statistics` +
        `&fields=items(snippet(title,thumbnails/high,channelId),contentDetails/duration,statistics)`
    );

    const item = response.data.items[0];
    if (!item) return null;

    if (parseDuration(item.contentDetails.duration) > 180) return null;

    const channelInfo = await getChannelInfo(item.snippet.channelId);

    return {
        videoId,
        title: item.snippet.title,
        thumbnail: item.snippet.thumbnails.high.url,
        duration: item.contentDetails.duration,
        creatorUsername: channelInfo.title,
        creatorAvatar: channelInfo.avatar,
        isVerified: channelInfo.isVerified,
        likes: parseInt(item.statistics?.likeCount || 0),
        comments: parseInt(item.statistics?.commentCount || 0),
        isAI: true
    };
}

async function getChannelInfo(channelId) {
    if (channelCache.has(channelId)) {
        return channelCache.get(channelId);
    }

    const response = await axios.get(
        `https://www.googleapis.com/youtube/v3/channels?key=${YOUTUBE_API_KEY}` +
        `&id=${channelId}&part=snippet,status` +
        `&fields=items(snippet(title,thumbnails/high/url),status)`
    );

    const data = response.data.items[0];
    const result = {
        title: data.snippet.title,
        avatar: data.snippet.thumbnails.high.url,
        isVerified: data.status?.longUploadsStatus === "eligible"
    };

    channelCache.set(channelId, result);
    return result;
}

async function saveVideos(videos) {
    const batch = db.batch();
    const now = admin.firestore.FieldValue.serverTimestamp();
    
    videos.forEach(video => {
        const ref = db.collection('videos').doc(video.videoId);
        batch.set(ref, { ...video, timestamp: now });
    });
    
    await batch.commit();
}

async function logExecution(count) {
    await db.collection('logs').add({
        date: admin.firestore.FieldValue.serverTimestamp(),
        videoCount: count,
        quotaUsed: calculateQuota(count)
    });
}

async function logError(error) {
    await db.collection('errors').add({
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
        message: error.message,
        stack: error.stack
    });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseDuration(duration) {
    const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    return (parseInt(match?.[1] || 0) * 3600) +
          (parseInt(match?.[2] || 0) * 60) +
          (parseInt(match?.[3] || 0));
}

function calculateQuota(videoCount) {
    return videoCount * 102;
}

fetchVideos();
