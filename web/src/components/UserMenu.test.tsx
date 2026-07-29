import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { UserMenu } from "./UserMenu";

describe("UserMenu", () => {
  it("shows the signed-in user's email", () => {
    render(<UserMenu email="casey@nsightcare.com" />);
    expect(screen.getByText("casey@nsightcare.com")).toBeInTheDocument();
  });

  it("offers a sign-out link to /logout", () => {
    render(<UserMenu email="casey@nsightcare.com" />);
    const link = screen.getByRole("link", { name: /sign out/i });
    expect(link).toHaveAttribute("href", "/logout");
  });

  it("is built on the .surface primitive (honors the surface tokens)", () => {
    const { container } = render(<UserMenu email="casey@nsightcare.com" />);
    expect(container.querySelector(".surface")).not.toBeNull();
  });
});
