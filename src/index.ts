import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import adminRouter from './routes/admin.js';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use('/admin', adminRouter);

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

const port = Number(process.env.PORT) || 4000;

const shouldListen = process.env.VERCEL !== '1';
if (shouldListen) {
  app.listen(port, () => {
    console.log(`Admin backend listening on port ${port}`);
  });
}

export default app;
