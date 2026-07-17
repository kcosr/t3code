const fs = require("node:fs");
const path = require("node:path");

const { withAndroidManifest, withDangerousMod } = require("expo/config-plugins");

const NETWORK_SECURITY_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="true">
    <trust-anchors>
      <certificates src="system" />
      <certificates src="user" />
    </trust-anchors>
  </base-config>
</network-security-config>
`;

module.exports = function withAndroidNetworkSecurity(config) {
  const withManifest = withAndroidManifest(config, (nextConfig) => {
    const application = nextConfig.modResults.manifest.application?.[0];

    if (application == null) {
      throw new Error(
        "AndroidManifest.xml is missing the application element required for network security configuration.",
      );
    }

    application.$ ??= {};
    application.$["android:networkSecurityConfig"] = "@xml/network_security_config";

    return nextConfig;
  });

  return withDangerousMod(withManifest, [
    "android",
    (nextConfig) => {
      const xmlDirectory = path.join(
        nextConfig.modRequest.platformProjectRoot,
        "app/src/main/res/xml",
      );
      fs.mkdirSync(xmlDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(xmlDirectory, "network_security_config.xml"),
        NETWORK_SECURITY_CONFIG,
        "utf8",
      );
      return nextConfig;
    },
  ]);
};
