# RTMS Developer Preview - Node.js 

This project is a brief demo on how to get started with the Node.JS SDK for RTMS.

> [!IMPORTANT]
> **Confidential under NDA  - Do not distribute during developer preview**<br />
> This document contains confidential information that requires an NDA. It is intended only for partners in the Zoom RTMS developer preview.
> Participation in the RTMS Developer Preview, including access to and use of these materials, is subject to [Zoom’s Beta Program - Terms of Use](https://www.zoom.com/en/trust/beta-terms-and-conditions/).

# Setup

The project will automatically clone the GitHub repo. Make sure that you have set up your SSH keys with GH.

```bash
 npm install github:zoom/rtms
 ```

### Developer Preview Only 

The Node.JS SDK is built on a C language SDK which means we have prebuilt binaries that we need to fetch. While the repository is private, we can use this command with a token to fetch those resources.

```bash
npm run fetch -- your-token-goes-here
```

# Usage

Copy the .env.example to .env and fill it out

```bash
cp .env.example .env
```

Run the index.js file to test

```bash
npm start
```
