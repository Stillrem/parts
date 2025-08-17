# Parts Hub (JS-only)
Статичный сайт + серверлес-функции. Без Python и без Google Sheets.
Разворачивается на Netlify или Vercel. API: /api/search

## Быстрый старт (Netlify)
1) Залей репозиторий в GitHub.
2) Netlify → New site from Git → выбери репо.
3) Publish directory: site
4) (опц.) Переменные окружения: EBAY_OAUTH
5) Открой сайт → введи модель / номер детали (MVWB835DW5, W11259006).

## Альтернатива (Vercel)
- Import Git repo → Output Directory: site
- API готов в /api/search

## Где править парсинг
- lib/sources.js — селекторы сайтов.
