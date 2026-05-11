// tests/middleware/auth.test.js — Auth middleware tests
const { requireAuth } = require('../../server/middleware/auth');

describe('requireAuth middleware', () => {
  let mockReq, mockRes, mockNext;

  beforeEach(() => {
    mockReq = { session: {} };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    mockNext = jest.fn();
  });

  it('should call next() when session has userId', () => {
    mockReq.session.userId = 42;
    requireAuth(mockReq, mockRes, mockNext);
    expect(mockNext).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it('should return 401 when session has no userId', () => {
    requireAuth(mockReq, mockRes, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockRes.json).toHaveBeenCalledWith({ error: 'Authentication required' });
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 401 when session is undefined', () => {
    mockReq.session = undefined;
    requireAuth(mockReq, mockRes, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should return 401 when userId is falsy (0)', () => {
    mockReq.session.userId = 0;
    requireAuth(mockReq, mockRes, mockNext);
    expect(mockRes.status).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });
});
