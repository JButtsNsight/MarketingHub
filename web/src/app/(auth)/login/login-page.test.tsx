import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import LoginPage from "./page";

describe("login landing (Socrates-mirrored SSO)", () => {
  it("names the app and offers a Google SSO sign-in through the org front door", () => {
    render(<LoginPage />);
    expect(screen.getByText(/marketinghub/i)).toBeInTheDocument();
    // The ALB gates everything, so this fallback just points back through SSO.
    const link = screen.getByRole("link", { name: /sign in with google/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/");
  });

  it("renders the standalone dark SSO card (mirrors the Socrates auth screen)", () => {
    const { container } = render(<LoginPage />);
    expect(container.querySelector(".sso-screen")).not.toBeNull();
    expect(container.querySelector(".sso-card")).not.toBeNull();
  });
});
