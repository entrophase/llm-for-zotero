import { assert } from "chai";
import {
  buildDirectConnectionVariables,
  formatManualProxyUrl,
  getCliProxyOverride,
  parseWindowsProxyRegistry,
} from "../src/utils/cliProxy";

describe("CLI network proxy", function () {
  it("formats a manual proxy and rejects an unusable one", function () {
    assert.equal(
      formatManualProxyUrl({
        protocol: "http",
        host: "127.0.0.1",
        port: "7890",
      }),
      "http://127.0.0.1:7890",
    );
    assert.equal(
      formatManualProxyUrl({
        protocol: "socks5",
        host: "socks5://10.0.0.2/",
        port: " 1080 ",
      }),
      "socks5://10.0.0.2:1080",
    );
    assert.equal(
      formatManualProxyUrl({ protocol: "http", host: "::1", port: "8080" }),
      "http://[::1]:8080",
    );
    assert.equal(
      formatManualProxyUrl({ protocol: "http", host: "", port: "7890" }),
      "",
    );
    assert.equal(
      formatManualProxyUrl({ protocol: "http", host: "a", port: "70000" }),
      "",
    );
  });

  it("imposes nothing in system mode or with an incomplete manual proxy", function () {
    const base = { protocol: "http" as const, host: "", port: "" };
    assert.isNull(getCliProxyOverride({ ...base, mode: "system" }));
    assert.isNull(getCliProxyOverride({ ...base, mode: "manual" }));
  });

  it("points every proxy variable at a manual proxy", function () {
    const env = getCliProxyOverride({
      mode: "manual",
      protocol: "socks5",
      host: "127.0.0.1",
      port: "7891",
    });
    assert.deepInclude(env, {
      HTTPS_PROXY: "socks5://127.0.0.1:7891",
      http_proxy: "socks5://127.0.0.1:7891",
      ALL_PROXY: "socks5://127.0.0.1:7891",
      NO_PROXY: "localhost,127.0.0.1,::1",
    });
  });

  it("clears inherited proxies and bypasses every proxy in none mode", function () {
    const env = getCliProxyOverride({
      mode: "none",
      protocol: "http",
      host: "127.0.0.1",
      port: "7890",
    });
    assert.deepEqual(env, buildDirectConnectionVariables());
    assert.equal(env?.HTTPS_PROXY, "");
    assert.equal(env?.all_proxy, "");
    assert.equal(env?.NO_PROXY, "*");
  });

  it("parses Windows registry proxy output when enabled", function () {
    const raw = `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    127.0.0.1:7897
    ProxyOverride    REG_SZ    localhost;127.*;<local>
`;
    const env = parseWindowsProxyRegistry(raw);
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7897");
    assert.equal(env.HTTP_PROXY, "http://127.0.0.1:7897");
    assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1,127.*");
  });

  it("parses Windows protocol-specific proxy with SOCKS", function () {
    const raw = `
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:7891
`;
    const env = parseWindowsProxyRegistry(raw);
    assert.equal(env.HTTP_PROXY, "http://127.0.0.1:7890");
    assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:7890");
    assert.equal(env.ALL_PROXY, "socks5://127.0.0.1:7891");
  });

  it("returns empty when Windows proxy is disabled or absent", function () {
    const disabled = `
    ProxyEnable    REG_DWORD    0x0
    ProxyServer    REG_SZ    127.0.0.1:7897
`;
    assert.deepEqual(parseWindowsProxyRegistry(disabled), {});
    assert.deepEqual(parseWindowsProxyRegistry(""), {});
  });
});
