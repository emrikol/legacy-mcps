# smb-share — LAN Manager SMB Server

A minimal Node.js SMB server that speaks the LANMAN2.1 dialect over NetBIOS-over-TCP (port 139). Designed specifically for Windows for Workgroups 3.11, which uses ancient LAN Manager protocols incompatible with modern Samba or macOS file sharing.

This lets a WFW 3.11 guest (in an emulator or on real hardware) mount a network share from the host Mac and use it as the IPC channel for the MCP agents.

## Why this exists

Modern SMB implementations speak NT LM 0.12 with Unicode, NTLMSSP, and NT status codes. WFW 3.11 only understands LANMAN2.1 with OEM codepages and DOS error codes. Nothing modern will negotiate down far enough — hence this purpose-built server.

## Usage

```bash
# Requires sudo — port 139 is privileged
sudo node lanman-server.js [share-path]

# Default share path is ./share/
# Files in share-path appear as \\MACHOST\SHARE inside WFW
```

## Connecting from Windows for Workgroups 3.11

1. Open **File Manager** → **Disk** → **Connect Network Drive**
2. Enter `\\MACHOST\SHARE` as the path
3. Assign a drive letter (e.g., `Z:`)
4. Click **OK**

Or from the DOS prompt inside WFW:

```
net use Z: \\MACHOST\SHARE
```

Then run the MCP agents against that drive:

```
DOSMCP.COM Z: /T
WINMCP.EXE Z:
```

## Network setup

The server binds to all interfaces on port 139. In DOSBox-X or 86Box with NAT networking, the host is reachable from the guest at `10.0.2.2`.

**Port 139 requires `sudo`** on macOS (privileged port).

## Share contents

The `share/` directory is the root of the network share. The `_MAGIC_/` subdirectory inside it is the IPC channel — command/response files appear there at runtime and are gitignored.

## Reference docs

`docs/` contains the protocol references used to build this:

- `MS-CIFS.md` — Microsoft CIFS/SMB protocol specification
- `rfc1001-netbios-over-tcp.txt` — NetBIOS over TCP/IP (RFC 1001)
- `rfc1002-netbios-over-tcp-detail.txt` — NetBIOS over TCP/IP detail (RFC 1002)
