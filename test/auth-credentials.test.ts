import { describe, expect, it, vi } from 'vitest';
import { AuthService, type AuthDeps } from '../src/modules/auth/auth.service.js';
function fixture() {
  const user = { id: 'u', orgId: 'org', passwordHash: 'hash', tokenVersion: 2, mustChangePassword: false, deletedAt: null };
  const d = {
    users: { findActiveByEmail: vi.fn().mockResolvedValue(user) },
    passwords: { verify: vi.fn().mockResolvedValue(true), dummyVerify: vi.fn() },
    lockout: { assertNotLocked: vi.fn(), recordFailure: vi.fn(), recordSuccess: vi.fn() },
    tokens: { signAccess: vi.fn().mockReturnValue('access') },
    refresh: { issueNewFamily: vi.fn().mockResolvedValue('refresh') },
  };
  return { d, user, auth: new AuthService(d as unknown as AuthDeps) };
}
describe('shared account credential verification', () => {
  it('normalizes email and verifies credentials without minting web tokens', async () => {
    const {auth,d,user}=fixture();
    expect(await auth.authenticateCredentials(' Person@Example.test ', 'password')).toEqual(user);
    expect(d.users.findActiveByEmail).toHaveBeenCalledWith('person@example.test');
    expect(d.lockout.assertNotLocked).toHaveBeenCalledWith('person@example.test');
    expect(d.passwords.verify).toHaveBeenCalledWith('password','hash');
    expect(d.lockout.recordSuccess).toHaveBeenCalledOnce();
    expect(d.tokens.signAccess).not.toHaveBeenCalled();
    expect(d.refresh.issueNewFamily).not.toHaveBeenCalled();
  });
  it('counts failed password and uses generic rejection', async () => {
    const {auth,d}=fixture();d.passwords.verify.mockResolvedValue(false);
    await expect(auth.authenticateCredentials('p@example.test','bad')).rejects.toMatchObject({code:'NAO_AUTENTICADO',message:'email ou senha inválidos'});
    expect(d.lockout.recordFailure).toHaveBeenCalledWith('p@example.test');
    expect(d.lockout.recordSuccess).not.toHaveBeenCalled();
  });
  it('retains dummy verification for unknown users', async () => {
    const {auth,d}=fixture();d.users.findActiveByEmail.mockResolvedValue(null);
    await expect(auth.authenticateCredentials('none@example.test','bad')).rejects.toMatchObject({code:'NAO_AUTENTICADO'});
    expect(d.passwords.dummyVerify).toHaveBeenCalledWith('bad');
    expect(d.lockout.recordFailure).toHaveBeenCalledOnce();
  });
  it('does not consult credentials when locked', async () => {
    const {auth,d}=fixture();d.lockout.assertNotLocked.mockRejectedValue(new Error('locked'));
    await expect(auth.authenticateCredentials('p@example.test','password')).rejects.toThrow('locked');
    expect(d.users.findActiveByEmail).not.toHaveBeenCalled();
  });
  it('still issues web tokens in normal login',async()=>{
    const {auth,d}=fixture();expect(await auth.login('p@example.test','password')).toEqual({access:'access',refresh:'refresh',mustChangePassword:false});
    expect(d.tokens.signAccess).toHaveBeenCalledOnce();expect(d.refresh.issueNewFamily).toHaveBeenCalledOnce();
  });
});
