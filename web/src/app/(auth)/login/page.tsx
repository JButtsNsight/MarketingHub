import { Surface } from "@/components/Surface";

/**
 * Pre-auth landing. In practice this is rarely seen: the ALB's
 * `authenticate-cognito` default action redirects unauthenticated requests
 * straight to the Google Workspace SSO before the app is ever reached. It
 * exists as a graceful fallback (e.g. an expired session mid-navigation) and
 * simply points the user back through SSO.
 */
export default function LoginPage() {
  return (
    <div className="login-landing">
      <Surface className="login-card" glint>
        <h1>MarketingHub</h1>
        <p className="login-sub">Campaign templates for NSight marketing.</p>
        <p className="login-help">
          Access is managed through NSight single sign-on. Sign in with your
          Google Workspace account to continue.
        </p>
        <a className="login-cta" href="/">
          Sign in with NSight SSO
        </a>
      </Surface>
    </div>
  );
}
