import { db } from "../repository/db.js";

export interface Product {
    id: number;
    name: string;
    price: number;
}

export class ProductService {
    async createProduct(data: Product): Promise<Product> {
        const newProduct: Product = {
            id: db.products.length + 1,
            name: data.name,
            price: data.price
        };

        db.products.push(newProduct);

        return newProduct;
    }

    async getAllProducts(): Promise<Product[]> {
        return db.products;
    }
}