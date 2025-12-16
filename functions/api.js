// functions/api.js
const express = require('express');
const serverless = require('serverless-http');
const axios = require('axios');
const crypto = require('crypto');
const cors = require('cors');

const app = express();

// --- CẤU HÌNH ---
// ĐIỀN LẠI APP ID VÀ SECRET
const APP_ID = 'YOUR_APP_ID';     
const APP_SECRET = 'YOUR_SECRET'; 
const SHOPEE_API_URL = 'https://open-api.affiliate.shopee.vn/graphql';

app.use(cors());

// CHÚ Ý: KHÔNG DÙNG express.json() hay express.text() ở đây nữa
// Chúng ta sẽ tự xử lý body thủ công để tránh xung đột

// --- HÀM 1: GIẢI MÃ & LÀM SẠCH LINK (GIỮ NGUYÊN) ---
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

// --- HÀM 2: GỌI API SHOPEE (GIỮ NGUYÊN) ---
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

// --- HÀM HELPER: PARSE BODY AN TOÀN TUYỆT ĐỐI ---
function safeParseBody(req) {
    try {
        // 1. Ưu tiên lấy từ Netlify Event gốc (được inject ở cuối file)
        let rawBody = req.netlifyEvent ? req.netlifyEvent.body : req.body;
        let isBase64 = req.netlifyEvent ? req.netlifyEvent.isBase64Encoded : false;

        // Nếu không có gì, trả về rỗng
        if (!rawBody) return {};

        // 2. Nếu đã là Object (do middleware nào đó parse rồi), dùng luôn
        if (typeof rawBody === 'object' && !Buffer.isBuffer(rawBody)) {
            return rawBody;
        }

        // 3. Nếu là Buffer, chuyển về String
        if (Buffer.isBuffer(rawBody)) {
            rawBody = rawBody.toString('utf8');
        }

        // 4. Nếu là Base64, giải mã
        if (isBase64 && typeof rawBody === 'string') {
            rawBody = Buffer.from(rawBody, 'base64').toString('utf8');
        }

        // 5. Parse JSON
        if (typeof rawBody === 'string') {
            // Trường hợp string rỗng
            if (rawBody.trim() === '') return {};
            return JSON.parse(rawBody);
        }

        return {};
    } catch (error) {
        console.error('[PARSE ERROR]:', error.message);
        throw new Error(`Parse Failed: ${typeof req.body} -> ${error.message}`);
    }
}

// --- API ROUTE ---
const apiPath = ['/convert-text', '/api/convert-text', '/.netlify/functions/api/convert-text'];

app.post(apiPath, async (req, res) => {
    
    let text = "";
    let subIds = [];

    try {
        // GỌI HÀM PARSE AN TOÀN
        const bodyData = safeParseBody(req);
        
        text = bodyData.text;
        subIds = bodyData.subIds;

        // Log để debug nếu vẫn lỗi
        if (!text) {
            console.log('[DEBUG] Parsed Body:', JSON.stringify(bodyData));
        }

    } catch (e) {
        return res.status(400).json({ 
            error: 'Lỗi đọc dữ liệu (Body Parsing)', 
            details: e.message 
        });
    }

    if (!text) return res.status(400).json({ error: 'Nội dung (text) bị trống' });

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

// Route 404
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// --- CẤU HÌNH QUAN TRỌNG: Inject Netlify Event ---
module.exports.handler = serverless(app, {
    request: (req, event, context) => {
        // Gắn toàn bộ sự kiện gốc của Netlify vào req để hàm safeParseBody dùng
        req.netlifyEvent = event;
    },
});
