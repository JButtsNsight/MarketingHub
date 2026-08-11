import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh }),
}));

import { RescheduleControl } from "./RescheduleControl";

const PROPS = {
  campaignId: "c1",
  status: "scheduled" as const,
  sendDate: "2030-01-15",
  sendTime: "09:30",
  sendTimezone: "America/New_York",
};

function stubFetch(status = 200, body: unknown = {}) {
  const fn = vi.fn(() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("RescheduleControl", () => {
  beforeEach(() => {
    refresh.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("renders nothing once the campaign is sending", () => {
    const { container } = render(
      <RescheduleControl {...PROPS} status="sending" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  test("expanded, the zone select is labeled Fallback zone with the one-line hint", async () => {
    const user = userEvent.setup();
    render(<RescheduleControl {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /reschedule/i }));

    expect(screen.getByLabelText(/fallback zone/i)).toBeInTheDocument();
    expect(
      screen.getByText(/fallback for contacts without a timezone/i),
    ).toBeInTheDocument();
  });

  test("save PATCHes the unchanged reschedule payload shape", async () => {
    const fetchFn = stubFetch();
    const user = userEvent.setup();
    render(<RescheduleControl {...PROPS} />);
    await user.click(screen.getByRole("button", { name: /reschedule/i }));

    fireEvent.change(screen.getByLabelText(/send date/i), {
      target: { value: "2030-01-16" }, // a Wednesday
    });
    await user.selectOptions(screen.getByLabelText(/send time/i), "10:00");
    await user.selectOptions(
      screen.getByLabelText(/fallback zone/i),
      "America/Chicago",
    );
    await user.click(screen.getByRole("button", { name: /save schedule/i }));

    expect(fetchFn).toHaveBeenCalledWith("/api/campaigns/c1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "reschedule",
        sendDate: "2030-01-16",
        sendTime: "10:00",
        sendTimezone: "America/Chicago",
      }),
    });
    expect(refresh).toHaveBeenCalled();
  });
});
