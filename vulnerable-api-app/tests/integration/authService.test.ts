import request from 'supertest';
import app from '../../src/app.js';

describe('Auth Integration Tests', () => {
  it('should login successfully with valid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        username: 'admin',
        password: 'password'
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    // Snapshot test: Ensures the response shape doesn't change
    expect(res.body).toMatchSnapshot(); 
  });

  it('should fail with invalid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        username: 'admin',
        password: 'wrongpassword'
      });

    expect(res.status).toBe(401);
  });
});