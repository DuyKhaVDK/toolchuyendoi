// functions/api.js

const express = require('express');
const serverless = require('serverless-http');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');

const app = express();

// --- CẤU HÌNH ---
const APP_ID = 'YOUR_APP_ID';     // Nhớ điền lại App ID
const APP_SECRET = 'YOUR_SECRET'; // Nhớ điền lại Secret
const SHOPEE_API_URL = 'https://open-api.affiliate.shopee.vn/graphql';

app.use(cors());

// --- THAY ĐỔI QUAN TRỌNG: PARSE BODY THỦ CÔNG ---
// Thay vì dùng body-parser, ta dùng express.json() và thêm middleware xử lý lỗi
app.use(express.json()); 
app.use(express.urlencoded({ extended: true }));

// Middleware Log để Debug (Xem server nhận được cái gì)
app.use((req, res, next) => {
    console.log(`[DEBUG] Method: ${req.method} | URL: ${req.url}`);
    // Log xem body có dữ liệu không
    if (req.body) {
        console.log('[DEBUG] Body received type:', typeof req.body);
    }
    next();
});

// --- CÁC HÀM LOGIC (GIỮ NGUYÊN) ---
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
    
    // --- KHẮC PHỤC LỖI BUFFER <Buffer > TẠI ĐÂY ---
    let bodyData = req.body;
    
    console.log('[DEBUG] Raw Body Type:', typeof bodyData); // Log để kiểm tra
    if (Buffer.isBuffer(bodyData)) {
         console.log('[DEBUG] Body is Buffer, converting...'); 
    }

    try {
        // TRƯỜNG HỢP 1: Dữ liệu là Buffer (Lỗi bạn đang gặp) -> Chuyển sang chuỗi rồi Parse
        if (Buffer.isBuffer(bodyData)) {
            const rawString = bodyData.toString('utf8');
            bodyData = JSON.parse(rawString);
        } 
        // TRƯỜNG HỢP 2: Dữ liệu là Chuỗi (String) -> Parse
        else if (typeof bodyData === 'string') {
            bodyData = JSON.parse(bodyData);
        }
        // TRƯỜNG HỢP 3: Đã là Object thì giữ nguyên
    } catch (e) {
        console.error('[ERROR] Parse Body Failed:', e.message);
        // Không return lỗi ngay, để code chạy tiếp xem có cứu được không
    }

    // Lấy dữ liệu an toàn
    const text = bodyData && bodyData.text ? bodyData.text : null;
    const subIds = bodyData && bodyData.subIds ? bodyData.subIds : [];

    if (!text) {
        // In ra log để xem rốt cuộc nó nhận được cái gì mà vẫn null
        console.error('[FINAL ERROR] Body parsed result:', bodyData);
        return res.status(400).json({ 
            error: 'Server nhận được dữ liệu rỗng (undefined)', 
            debugInfo: 'Check Netlify Logs' 
        });
    }
    // ------------------------------------------

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

app.use('*', (req, res) => res.status(404).json({ error: 'Not found', path: req.path }));

module.exports.handler = serverless(app);
