import { FormEvent, useState } from 'react';
import { ArrowRight, CheckCircle2, Eye, EyeOff, LockKeyhole, Mail, MessageCircleMore } from 'lucide-react';
import { api, type PublicPlatformInfo, type User } from '../lib/api';

export default function Login({ onLogin, platform }: { onLogin: (user: User) => void; platform: PublicPlatformInfo }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (mode === 'register' && !platform.registrationEnabled) return setError('Registration is disabled. Please contact platform support.');
    setLoading(true);
    try {
      const result = mode === 'login' ? await api.login(email.trim(), password) : await api.register({ name: name.trim(), company: company.trim(), email: email.trim(), password });
      localStorage.setItem('waba_token', result.token);
      onLogin(result.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-story">
        <div className="login-grid" />
        <div className="login-brand">
          <div className="brand-mark"><MessageCircleMore size={25} strokeWidth={2.4} /></div>
          <span>{platform.platformName}</span>
        </div>
        <div className="story-content">
          <span className="eyebrow light">Customer conversations, simplified</span>
          <h1>Turn every message into a meaningful connection.</h1>
          <p>Manage your WhatsApp Business conversations, campaigns and customer relationships from one focused workspace.</p>
          <div className="story-points">
            <span><CheckCircle2 size={18} /> Official WhatsApp Business API</span>
            <span><CheckCircle2 size={18} /> Secure, role-based access</span>
            <span><CheckCircle2 size={18} /> Live delivery intelligence</span>
          </div>
        </div>
        <div className="floating-chat chat-one"><span className="avatar-chip teal">AN</span><div><b>New customer message</b><small>Hi! Is my order ready?</small></div><i>now</i></div>
        <div className="floating-chat chat-two"><span className="status-pulse" /><div><b>Campaign delivered</b><small>2,840 recipients reached</small></div><i>98%</i></div>
        <p className="story-foot">Trusted infrastructure for customer-first teams</p>
      </section>

      <section className="login-panel">
        <div className="login-card">
          <span className="mobile-brand"><span className="brand-mark small"><MessageCircleMore size={19} /></span> {platform.platformName}</span>
          <div className="login-heading">
            <span className="welcome-icon"><LockKeyhole size={20} /></span>
            <h2>{mode === 'login' ? platform.loginTitle : 'Create your workspace'}</h2>
            <p>{mode === 'login' ? platform.loginDescription : 'Start managing customer conversations with your team.'}</p>
          </div>
          <form onSubmit={submit}>
            {platform.maintenanceMessage && <div className="form-info">{platform.maintenanceMessage}</div>}
            {!platform.memberAccessEnabled && <div className="form-info">Workspace sign-in is paused. Platform superadmins can still sign in.</div>}
            {mode === 'register' && platform.signupRestricted && <div className="form-info">Registration is limited to approved email domains.</div>}
            {mode === 'register' && platform.trialDays > 0 && <div className="form-info">New workspaces have an initial {platform.trialDays}-day subscription period. Contact support to extend access.</div>}
            {mode === 'register' && <><label>Your name</label><div className="input-wrap"><input type="text" placeholder="Your full name" value={name} onChange={e => setName(e.target.value)} required /></div><label>Business name</label><div className="input-wrap"><input type="text" placeholder="Your company or workspace" value={company} onChange={e => setCompany(e.target.value)} required /></div></>}
            <label>Email address</label>
            <div className="input-wrap"><Mail size={18} /><input type="email" placeholder="you@company.com" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email" /></div>
            <div className="label-row"><label>Password</label>{mode === 'login' && <button type="button" className="text-button" onClick={() => setInfo('Contact your platform administrator or support to reset your password.')}>Forgot password?</button>}</div>
            <div className="input-wrap"><LockKeyhole size={18} /><input type={showPassword ? 'text' : 'password'} placeholder="Enter your password" value={password} onChange={e => setPassword(e.target.value)} required minLength={mode === 'register' ? platform.passwordMinLength : undefined} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} /><button type="button" className="eye-button" onClick={() => setShowPassword(v => !v)} aria-label="Toggle password visibility">{showPassword ? <EyeOff size={18} /> : <Eye size={18} />}</button></div>
            {error && <div className="form-error">{error}</div>}
            {info && <div className="form-info">{info}</div>}
            {mode === 'register' && <p className="login-password-policy">Password: at least {platform.passwordMinLength} characters{platform.passwordRequireUppercase ? ', an uppercase letter' : ''}{platform.passwordRequireNumber ? ', a number' : ''}.</p>}
            <button className="primary-button" disabled={loading}>{loading ? <span className="button-spinner" /> : <>{mode === 'login' ? 'Sign in to dashboard' : 'Create workspace'} <ArrowRight size={18} /></>}</button>
          </form>
          {(platform.registrationEnabled || mode === 'register') && <p className="login-help">{mode === 'login' ? `New to ${platform.platformName}?` : 'Already have an account?'} <button className="auth-mode-button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); setInfo(''); }}>{mode === 'login' ? 'Create an account' : 'Sign in'}</button></p>}
          {platform.supportEmail && <p className="login-help">Support: <a href={`mailto:${platform.supportEmail}`}>{platform.supportEmail}</a></p>}
          {platform.supportPhone && <p className="login-help">Support phone: {platform.supportPhone}</p>}
          {platform.supportUrl && <p className="login-help"><a href={platform.supportUrl} target="_blank" rel="noopener noreferrer">Help & support</a></p>}
        </div>
        {platform.footerText && <p className="legal">{platform.footerText}</p>}
        {(platform.termsUrl || platform.privacyUrl) && <p className="legal">{platform.termsUrl && <a href={platform.termsUrl} target="_blank" rel="noopener noreferrer">Terms of Service</a>}{platform.termsUrl && platform.privacyUrl ? ' · ' : ''}{platform.privacyUrl && <a href={platform.privacyUrl} target="_blank" rel="noopener noreferrer">Privacy Policy</a>}</p>}
      </section>
    </main>
  );
}
