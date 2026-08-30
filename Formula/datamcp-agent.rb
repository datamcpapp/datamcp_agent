class DatamcpAgent < Formula
  desc "DataMCP local tunnel agent for private PostgreSQL databases"
  homepage "https://datamcp.app"
  url "https://registry.npmjs.org/@datamcp/agent/-/agent-0.1.0.tgz"
  sha256 "REPLACE_WITH_NPM_TARBALL_SHA256"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec/"bin/datamcp-agent"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/datamcp-agent --version")
  end
end
