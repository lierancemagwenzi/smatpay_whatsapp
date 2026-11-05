const axios = require('axios');
const jsQR = require('jsqr');
const jpeg = require('jpeg-js');
const {PNG} = require('pngjs');
const apiHelper = require('./apiHelper');

/**
 * Photos sent to the bot: downloading them from 360dialog and reading a QR code in them.
 *
 * 360dialog: GET /<media_id> returns a Meta media URL; the file itself is fetched through
 * 360dialog by swapping that URL's host for the 360dialog one, with the same API key.
 */

const MAX_BYTES = 10 * 1024 * 1024;

function decodeImage(buffer, mimeType) {
    if (/png/i.test(mimeType || '') || buffer.subarray(1, 4).toString() === 'PNG') {
        const png = PNG.sync.read(buffer);
        return {data: new Uint8ClampedArray(png.data), width: png.width, height: png.height};
    }
    const image = jpeg.decode(buffer, {useTArray: true, maxMemoryUsageInMB: 256});
    return {data: new Uint8ClampedArray(image.data), width: image.width, height: image.height};
}

module.exports = {
    download: async function (mediaId) {
        const headers = {'D360-API-KEY': apiHelper.apiKey()};
        const meta = await axios.get(`${apiHelper.baseUrl()}/${encodeURIComponent(mediaId)}`, {headers, timeout: 15000});
        const source = new URL(meta.data.url);
        const viaDialog = `${apiHelper.baseUrl()}${source.pathname}${source.search}`;
        const file = await axios.get(viaDialog, {headers, responseType: 'arraybuffer', timeout: 30000, maxContentLength: MAX_BYTES});
        return {buffer: Buffer.from(file.data), mimeType: meta.data.mime_type || file.headers['content-type']};
    },

    /** Uploads an image to WhatsApp (through 360dialog) and returns its media id, for sendImage. */
    upload: async function (buffer, mimeType, filename) {
        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('file', new Blob([buffer], {type: mimeType}), filename);
        const res = await axios.post(`${apiHelper.baseUrl()}/media`, form, {headers: {'D360-API-KEY': apiHelper.apiKey()}, timeout: 30000});
        return res.data.id;
    },

    /** The text of the first QR code found in an image buffer, or null. */
    readQr: function (buffer, mimeType) {
        const {data, width, height} = decodeImage(buffer, mimeType);
        const found = jsQR(data, width, height, {inversionAttempts: 'attemptBoth'});
        return found?.data || null;
    },
};
