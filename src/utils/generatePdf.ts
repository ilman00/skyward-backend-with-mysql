// src/utils/generatePdf.ts

const RENDER_SERVICE_URL = process.env.PDF_RENDER_SERVICE_URL;
// e.g. "https://pdf-render-service-xxxxx.a.run.app/generate-pdf"

export async function generatePdfFromHtml(html: string): Promise<Buffer> {
    if (!RENDER_SERVICE_URL) {
        throw new Error("PDF_RENDER_SERVICE_URL is not set in environment variables");
    }

    const response = await fetch(RENDER_SERVICE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`PDF render service failed: ${response.status} ${errorText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
}