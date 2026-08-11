/**
 * Pre-auth landing — a faithful mirror of the standalone Socrates (NCore) sign-in
 * screen: a centered dark card with a letterspaced Geist wordmark, a muted subtitle, a
 * single white "Sign in with Google" control, and a status line.
 *
 * Unlike Socrates it does NOT run a client-side PKCE flow. MarketingHub auth is
 * delegated to the ALB's `authenticate-cognito` front door, so the control just
 * navigates to `/`; the ALB intercepts the unauthenticated request and redirects
 * through Google Workspace SSO. This page is only ever seen as a graceful
 * fallback (e.g. an expired session mid-navigation). Rendered as a fixed
 * full-screen layer so it reads as a standalone login over the app shell.
 */
function GoogleGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

export default function LoginPage() {
  return (
    <div className="sso-screen">
      <div className="sso-card">
        <h1 className="sso-wordmark">Marketing Hub</h1>
        <p className="sso-sub">Sign in with your work account</p>
        <a className="sso-btn" href="/">
          <GoogleGlyph />
          Sign in with Google
        </a>
        <p className="sso-status">
          Access is managed through single sign-on — you&apos;ll be redirected
          to your Google Workspace account.
        </p>
      </div>
    </div>
  );
}
