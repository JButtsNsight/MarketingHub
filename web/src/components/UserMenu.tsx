import { Surface } from "./Surface";

/**
 * The signed-in user chip in the masthead: the Cognito email (from the ALB
 * OIDC-data header, resolved server-side) plus a sign-out link.
 *
 * Sign-out points at `/logout`, a route that clears the ALB auth-session cookie
 * and redirects to the Cognito Hosted-UI logout endpoint (which in turn signs
 * out of the Google Workspace SAML session). Built on `.surface` so it honors
 * the global glass/flat skin.
 */
export function UserMenu({ email }: { email: string }) {
  return (
    <Surface className="user-menu">
      <span className="user-menu-email mono" title={email}>
        {email}
      </span>
      <a className="user-menu-signout" href="/logout">
        Sign out
      </a>
    </Surface>
  );
}

export default UserMenu;
