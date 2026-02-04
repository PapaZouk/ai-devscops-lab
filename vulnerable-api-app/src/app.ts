import express from 'express';
import authRoutes from './api/authRoutes.js';
import productRoutes from './api/productRoutes.js';

const app = express();

app.use(express.json());
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);


if (import.meta.url === `file://${process.argv[1]}`) {
  app.listen(3000, () => {
    console.log('Server is running on port 3000');
  });
}

export default app;