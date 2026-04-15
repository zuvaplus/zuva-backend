require('dotenv').config();
const express = require('express');
const zuvaRoutes = require('./zuva-api');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Temporary auth shim — replace with real JWT middleware later
app.use((req, res, next) => {
  req.user = {
    id:          '00000000-0000-0000-0000-000000000002',
    role:        'creator',
    email:       'test@zuva.tv',
    countryCode: 'NG',
  };
  next();
});

app.use('/api', zuvaRoutes);

app.get('/health',  (req, res) => res.json({ status: 'ok', platform: 'Zuva.tv' }));
app.get('/healthz', (req, res) => res.json({ status: 'ok', platform: 'Zuva.tv' }));

app.listen(PORT, () => {
  console.log(`Zuva backend running on http://localhost:${PORT}`);
});