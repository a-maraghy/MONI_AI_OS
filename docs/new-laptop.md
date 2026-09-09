# Moving to a New Laptop

## What is actually tied to this laptop

Only three things:

| Item | Location | Replaceable? |
|---|---|---|
| SSH private key | `C:\Users\<you>\.ssh\contabo_vps` | Yes — make a new one |
| SSH config (`contabo` alias) | `C:\Users\<you>\.ssh\config` | Yes — 6 lines, retype it |
| RDP launcher | `Connect-VpsRdp.ps1` (this folder) | Yes — copy the file |

**Nothing else.** Your Claude Code login, `gh` login, RDP password, and all files
live on the server and are unaffected by changing laptops.

---

## Scenario A — Planned move (old laptop still works)

Do this BEFORE wiping/selling the old one. Do NOT copy the private key across.
Make a new key for the new laptop instead, so the old laptop can be revoked.

**On the NEW laptop:**

    ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\contabo_vps -C "new-laptop"
    type $env:USERPROFILE\.ssh\contabo_vps.pub

Copy the printed public key line.

**On the OLD laptop**, authorize it (paste the new pubkey in place of NEWKEY):

    ssh contabo "echo 'NEWKEY' >> /root/.ssh/authorized_keys"
    ssh contabo "echo 'NEWKEY' >> /home/ubuntu/.ssh/authorized_keys"

**On the NEW laptop**, create `C:\Users\<you>\.ssh\config`:

    Host contabo
      HostName 173.249.51.80
      User root
      IdentityFile ~/.ssh/contabo_vps
      IdentitiesOnly yes
      ServerAliveInterval 30
      ServerAliveCountMax 4

Fix the key permissions (Windows OpenSSH refuses keys other users can read):

    icacls $env:USERPROFILE\.ssh\contabo_vps /inheritance:r /grant:r "$($env:USERNAME):(R)"

Test:  `ssh contabo "hostname"`

**Then revoke the old laptop** — once the new one works:

    ssh contabo "sed -i '/claude-code@GSHN1101/d' /root/.ssh/authorized_keys"
    ssh contabo "sed -i '/claude-code@GSHN1101/d' /home/ubuntu/.ssh/authorized_keys"

Skipping this step means a laptop you no longer control still has root.

---

## Scenario B — Old laptop lost, stolen, or dead

You have no SSH access. This is what the `ubuntu` password is for.

1. Log in to the Contabo customer panel.
2. Open the **VNC / noVNC console** for the VPS (browser-based screen access,
   independent of SSH and of the firewall).
3. Log in at the console as `ubuntu` with the password you set.
4. Add the new laptop's public key:

       mkdir -p ~/.ssh && echo 'NEWKEY' >> ~/.ssh/authorized_keys
       chmod 600 ~/.ssh/authorized_keys

5. From the new laptop, `ssh -l ubuntu contabo` should now work. Re-add the key
   to root the same way, then remove the lost laptop's key (see Scenario A).

**If the laptop was stolen, revoke the old key immediately** — its private key had
passwordless root on this server.

---

## Verify you are talking to the right server

On first connection from a new machine, SSH shows a host key fingerprint.
It must match one of these:

    ED25519  SHA256:6iNE0J9Ih4wdE73yVr6g6qRWzHQ8JGGib/Dl9/gFwfI
    RSA      SHA256:bOs8WQkT7UYml+3lb/zHxqQf32ho6Bb4kAaoKHO6TSo

If it does not match, do not type `yes` — something is intercepting the connection.

---

## If you would rather just copy the key

It works, but it is the weaker option: you cannot revoke one laptop without
revoking both, and the key has no passphrase, so anyone who reads the file in
transit gets root. If you do it, move `contabo_vps` and `contabo_vps.pub` over an
encrypted channel, never email or chat, then run the `icacls` command above.
