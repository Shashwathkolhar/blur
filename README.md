# Blur

Pixelate sensitive info in screenshots and PDFs, mark them up with boxes, circles, lines
and arrows, and sign documents. Signatures can be saved in your browser for next time.
Everything runs in your browser. Files are never uploaded.

**Use it:** https://shashwathkolhar.github.io/blur/

When a PDF page is pixelated, that page is exported as an image so the hidden text is
really removed. Pages that are only signed or marked keep their original, selectable text.

Run locally: `python3 serve.py`, then open http://localhost:5173

PDF support uses [PDF.js](https://mozilla.github.io/pdf.js/) (Apache-2.0) and
[pdf-lib](https://pdf-lib.js.org/) (MIT), bundled in `vendor/`.
