import request from 'supertest';
import app from '../../src/app.js';

describe('Auth Integration Tests', () => {
  let server: any;

  beforeAll((done) => {
    server = app.listen(4000, done);
  });

  afterAll((done) => {
    server.close(done);
  });

  it('should login successfully with valid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        username: 'admin',
        password: 'password'
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(typeof res.body.token).toBe('string');
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