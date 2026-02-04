import { Router } from "express";
import { login } from "../services/authService.js";

const authRoutes = Router();

authRoutes.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
    
        const token = await login(username, password);
        res.json({ token });
    } catch (error) {
        res.status(401).json({ message: 'Authentication failed' });
    }
});

export default authRoutes;