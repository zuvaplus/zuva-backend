const cors = require('cors');

const ALLOWED_ORIGINS = [
  'https://zuva.tv',
  'https://www.zuva.tv',
  'https://zuva-frontend-production.up.railway.app',
  ...(process.env.NODE_ENV === 'development'
    ? ['http://localhost:3000', 'http://localhost:3001']
    : []),
];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS blocked: origin ${origin} is not permitted`));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  credentials: true,
  maxAge: 86400,
};

module.exports = cors(corsOptions);
