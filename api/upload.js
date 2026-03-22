import { IncomingForm } from 'formidable';
import fs from 'fs';
import FormData from 'form-data';
import fetch from 'node-fetch';

// Konfigurasi ini wajib agar Vercel tidak memotong stream file
export const config = {
    api: { bodyParser: false }
};

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const form = new IncomingForm();
    
    form.parse(req, async (err, fields, files) => {
        if (err) return res.status(500).json({ success: false, error: err.message });

        const file = files.file[0]; // Tergantung versi formidable, kadang files.file
        const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = process.env.TELEGRAM_CHAT_ID;

        // Siapkan data untuk dikirim ke Telegram
        const tgFormData = new FormData();
        tgFormData.append('chat_id', chatId);
        tgFormData.append('document', fs.createReadStream(file.filepath), file.originalFilename);

        try {
            // Tembak ke API Telegram
            const tgResponse = await fetch(`https://api.telegram.org/bot${telegramToken}/sendDocument`, {
                method: 'POST',
                body: tgFormData,
            });

            const tgData = await tgResponse.json();

            if (tgData.ok) {
                // Telegram mengembalikan file_id yang bisa Anda simpan di database nanti
                res.status(200).json({ 
                    success: true, 
                    file_id: tgData.result.document.file_id 
                });
            } else {
                res.status(400).json({ success: false, error: tgData.description });
            }
        } catch (error) {
            res.status(500).json({ success: false, error: "Gagal menghubungi Telegram API" });
        }
    });
}
