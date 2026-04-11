import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import propertyRoutes from './routes/properties';
import { requireAuth } from './middleware/auth';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4001;

export const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

app.use(helmet());
app.use(cors({
  origin: ['http://localhost:3001','http://localhost:3002','http://localhost:3003','http://localhost:3004','http://localhost:3005','http://localhost:3006','http://localhost:3007','https://experience.arcgis.com'],
  credentials: true,
}));
app.use(morgan('dev'));
app.use(express.json({ limit: "50mb" }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'gam-property-api', port: PORT });
});

app.use('/api/properties', requireAuth, propertyRoutes);

app.listen(PORT, () => {
  console.log(`Property API running on port ${PORT}`);
});
