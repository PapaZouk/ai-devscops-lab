import dotenv from "dotenv";
import jwt from "jsonwebtoken";

// Load environment variables from .env file
dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
	throw new Error("JWT_SECRET is not defined in environment variables");
}

export const signToken = (payload: object, options?: jwt.SignOptions) => {
	return jwt.sign(payload, JWT_SECRET, options);
};

export const verifyToken = (token: string) => {
	return jwt.verify(token, JWT_SECRET);
};
