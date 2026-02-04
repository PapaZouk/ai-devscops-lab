import { Router } from "express";
import z from "zod";
import { ProductService } from "../services/productService.js";

const productRoutes = Router();
const productService = new ProductService();

const productSchema = z.object({
    name: z.string().min(3),
    price: z.number().positive(),
});

productRoutes.post('/', async (req, res) => {
    const validation = productSchema.safeParse(req.body);

    if (!validation.success) {
        return res.status(400).json({ errors: (validation.error as z.ZodError).message });
    }
    
    try {
        const product = await productService.createProduct(req.body);
        res.status(201).json(product);
    } catch (error) {
        res.status(500).json({ message: 'Internal server error' });
    }
});

export default productRoutes;
