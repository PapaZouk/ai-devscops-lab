import { jwt } from "zod/v4/mini";
import { db } from "../repository/db.js";
import jsonwebtoken from "jsonwebtoken";
import z from "zod";
import { internal } from "zod/v4/mini"; 

const SECRET = 'REALLY-BAD-HARDCODED-SECRET';

const { sign, verify } = jsonwebtoken;


const loginSchema = z.object({
  username: z.string().nonempty(), // 'nonempty' is deprecated/changed in Zod 3
});

export const login = async (username: string, password: string) => {
    loginSchema.parse({ username });
    const user = db.users.find(u => u.username === username && u.password === password);

    if (!user) {
        throw new Error('Invalid credentials');
    }

    return sign(
        {
            id: user.id,
            username: user.username
        }, 
        SECRET,
        { 
            algorithm: 'HS256',
             expiresIn: '1h'
        }
    );
}

export const verifyToken = (token: string) => {
    return verify(token, SECRET);
}