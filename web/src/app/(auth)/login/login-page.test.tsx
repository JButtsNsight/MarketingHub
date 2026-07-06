import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import LoginPage from "./page";

describe("login landing", () => {
  it("names the app and explains that sign-in goes through the org SSO", () => {
    render(<LoginPage />);
    expect(screen.getByText(/marketinghub/i)).toBeInTheDocument();
    // The ALB gates everything, so this page is rarely seen — it just points at SSO.
    expect(screen.getByRole("link", { name: /sign in/i })).toBeInTheDocument();
  });

  it("is built on the .surface primitive", () => {
    const { container } = render(<LoginPage />);
    expect(container.querySelector(".surface")).not.toBeNull();
  });
});
