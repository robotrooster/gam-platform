import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import propertyRoutes from './routes/properties';

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
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'gam-property-api', port: PORT });
});

app.use('/api/properties', propertyRoutes);

app.listen(PORT, () => {
  console.log(`Property API running on port ${PORT}`);
});
