// functions/api.js

const express = require('express');
const serverless = require('serverless-http');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');

const app = express();

// --- CẤU HÌNH ---
const APP_ID = 'YOUR_APP_ID';     // ĐIỀN LẠI APP ID
const APP_SECRET = 'YOUR_SECRET'; // ĐIỀN LẠI SECRET
const SHOPEE_API_URL = 'https://open-api.affiliate.shopee.vn/graphql';

app.use(cors());

// --- CHIẾN THUẬT MỚI: ĐỌC TẤT CẢ LÀ TEXT ---
// Thay vì express.json(), ta dùng express.text để lấy dữ liệu thô
// type: '*/*' nghĩa là chấp nhận mọi loại Content-Type
app.use(express.text({ type: '*/*' }));

// --- HÀM LOGIC (GIỮ NGUYÊN) ---
async function resolveAndCleanUrl(inputUrl) {
    let finalUrl = inputUrl;
    if (inputUrl.includes('s.shopee.vn') || inputUrl.includes('shp.ee') || inputUrl.includes('vn.shp.ee')) {
        try {
            const response = await axios.get(inputUrl, { maxRedirects: 5, validateStatus: null });
            finalUrl = response.request.res.responseUrl || inputUrl;
        } catch (error) {}
    }
    let baseUrl = finalUrl.split('?')[0]; 
    if (baseUrl.includes('/search')) {
        try {
            const urlObj = new URL(finalUrl);
            const originalParams = urlObj.searchParams;
            const newParams = new URLSearchParams();
            ['keyword', 'shop', 'evcode', 'signature', 'promotionId', 'mmp_pid'].forEach(key => {
                if (originalParams.has(key)) newParams.append(key, originalParams.get(key));
            });
            if (newParams.toString() === "") return baseUrl;
            return `${baseUrl}?${newParams.toString()}`;
        } catch (e) { return baseUrl; }
    }
    const shopProductPattern = /shopee\.vn\/([^\/]+)\/(\d+)\/(\d+)/;
    const match = baseUrl.match(shopProductPattern);
    if (match) return `https://shopee.vn/product/${match[2]}/${match[3]}`;
    if (baseUrl.includes('/m/') || baseUrl.includes('/product/') || (baseUrl.split('/').length === 4)) return baseUrl; 
    if (finalUrl.includes('uls_trackid=')) finalUrl = finalUrl.split('uls_trackid=')[0];
    if (finalUrl.includes('utm_source=')) finalUrl = finalUrl.split('utm_source=')[0];
    if (!finalUrl.includes('/search') && finalUrl.includes('mmp_pid=')) finalUrl = finalUrl.split('mmp_pid=')[0];
    if (finalUrl.endsWith('?') || finalUrl.endsWith('&')) finalUrl = finalUrl.slice(0, -1);
    return finalUrl;
}

async function getShopeeShortLink(originalUrl, subIds = []) {
    const timestamp = Math.floor(Date.now() / 1000);
    let subIdsParam = "";
    if (subIds && subIds.length > 0) {
        const validIds = subIds.filter(id => id && id.trim() !== "");
        if (validIds.length > 0) {
            const formattedIds = validIds.map(id => `"${id.trim()}"`).join(",");
            subIdsParam = `, subIds: [${formattedIds}]`;
        }
    }
    const query = `mutation { generateShortLink(input: { originUrl: "${originalUrl}" ${subIdsParam} }) { shortLink } }`;
    const payloadString = JSON.stringify({ query });
    const stringToSign = `${APP_ID}${timestamp}${payloadString}${APP_SECRET}`;
    const signature = crypto.createHash('sha256').update(stringToSign).digest('hex');

    try {
        const response = await axios.post(SHOPEE_API_URL, payloadString, {
            headers: { 'Content-Type': 'application/json', 'Authorization': `SHA256 Credential=${APP_ID}, Timestamp=${timestamp}, Signature=${signature}` }
        });
        if (response.data.errors) return null;
        return response.data.data.generateShortLink.shortLink;
    } catch (e) { return null; }
}

// --- API ROUTE ---
const apiPath = ['/convert-text', '/api/convert-text', '/.netlify/functions/api/convert-text'];

app.post(apiPath, async (req, res) => {
    
    let text = "";
    let subIds = [];

    // --- XỬ LÝ DỮ LIỆU THÔ (THỦ CÔNG) ---
    try {
        let rawBody = req.body; // Đây sẽ là chuỗi string nhờ express.text()
        
        // Nếu nó vẫn là object (trường hợp hiếm), ta dùng luôn
        if (typeof rawBody === 'object') {
            text = rawBody.text;
            subIds = rawBody.subIds;
        } else {
            // Parse chuỗi JSON thủ công
            const parsed = JSON.parse(rawBody);
            text = parsed.text;
            subIds = parsed.subIds;
        }
    } catch (e) {
        console.error('[ERROR] JSON Parse Failed:', e.message);
        console.error('[ERROR] Raw Body Received:', req.body);
        
        // Trả về lỗi chi tiết để Frontend hiển thị (không bị undefined nữa)
        return res.status(400).json({ 
            error: 'Lỗi đọc dữ liệu từ Client', 
            details: e.message,
            received: String(req.body).substring(0, 100) // Cắt ngắn để xem thử
        });
    }
    // -------------------------------------

    if (!text) {
        return res.status(400).json({ error: 'Nội dung (text) bị trống' });
    }

    const urlRegex = /(https?:\/\/(?:www\.)?(?:shopee\.vn|vn\.shp\.ee|shp\.ee|s\.shopee\.vn)[^\s]*)/gi;
    const uniqueLinks = [...new Set(text.match(urlRegex) || [])];

    if (uniqueLinks.length === 0) return res.json({ success: true, newText: text, message: 'No links found', converted: 0 });

    const conversions = await Promise.all(uniqueLinks.map(async (url) => {
        let cleanInput = url.replace(/[.,;!?)]+$/, ""); 
        const realProductUrl = await resolveAndCleanUrl(cleanInput);
        const myShortLink = await getShopeeShortLink(realProductUrl, subIds);
        return { original: url, resolved: realProductUrl, short: myShortLink };
    }));

    let newText = text;
    let successCount = 0;
    conversions.forEach(item => {
        if (item.short) {
            newText = newText.split(item.original).join(item.short);
            successCount++;
        }
    });

    res.json({ success: true, newText, totalLinks: uniqueLinks.length, converted: successCount, details: conversions });
});

app.use('*', (req, res) => res.status(404).json({ error: 'Route not found', path: req.
