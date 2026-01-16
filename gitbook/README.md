---
description: Welcome to your team’s developer platform
layout:
  width: wide
  title:
    visible: false
  description:
    visible: false
  tableOfContents:
    visible: false
  outline:
    visible: false
  pagination:
    visible: false
  metadata:
    visible: true
metaLinks:
  alternates:
    - https://app.gitbook.com/s/2AwfWOGBWBxQmyvHedqW/
---

# Developer Platform

<h2 align="center">mqBase</h2>

<p align="center">MQTT, SQL and web admin in one place</p>

<p align="center"><a href="http://app.gitbook.com/join" class="button primary">Sign up</a> <a href="http://app.gitbook.com/join" class="button secondary">Log in</a></p>

<table data-card-size="large" data-view="cards"><thead><tr><th></th><th></th><th></th><th data-hidden data-card-target data-type="content-ref"></th><th data-hidden data-card-cover data-type="files"></th></tr></thead><tbody><tr><td><h4><i class="fa-server">:server:</i></h4></td><td>Managed</td><td>Learn more about managed mqBase service</td><td><a href="https://template.gitbook.com/space-product-docs">https://template.gitbook.com/space-product-docs</a></td><td><a href=".gitbook/assets/hosted.jpg">hosted.jpg</a></td></tr><tr><td><h4><i class="fa-terminal">:terminal:</i></h4></td><td>Self-hosted</td><td>Learn how to self-host mqBase</td><td><a href="https://template.gitbook.com/space-api-reference">https://template.gitbook.com/space-api-reference</a></td><td><a href=".gitbook/assets/api-reference.jpg">api-reference.jpg</a></td></tr></tbody></table>

{% columns %}
{% column %}
### Get started in 5 minutes

Setting up your first API call should be the easiest part of getting started. With clear endpoints, copy-paste-ready examples, and quick authentication, you’ll be up and running in minutes—not hours.

No guesswork, no complexity—just your first successful call, fast.

<a href="https://template.gitbook.com/space-product-docs" class="button primary" data-icon="rocket-launch">Get started</a> <a href="https://template.gitbook.com/space-api-reference" class="button secondary" data-icon="terminal">API reference</a>
{% endcolumn %}

{% column %}
{% code title="index.js" overflow="wrap" %}
```javascript
// Import the SDK
import ExampleAPI from "example-api";

// Initialize the client
const client = new ExampleAPI({ apiKey: "YOUR_API_KEY" });

// Send your first message
const response = await client.messages.send({
  message: "Hello, world!"
});

```
{% endcode %}
{% endcolumn %}
{% endcolumns %}

{% columns %}
{% column %}
<figure><img src="https://gitbookio.github.io/onboarding-template-images/placeholder.png" alt=""><figcaption></figcaption></figure>
{% endcolumn %}

{% column %}
### Learn more about the developer platform

Read guides, watch tutorials, and learn more about working with the developer platform and integrating it with your own stack.

<a href="https://template.gitbook.com/space-help-center" class="button primary" data-icon="book-open">Guides</a> <a href="https://template.gitbook.com/space-product-docs" class="button secondary" data-icon="book">Documentation</a>
{% endcolumn %}
{% endcolumns %}

<h2 align="center">Join us and create your first PR in just a few steps</h2>

<table data-card-size="large" data-view="cards"><thead><tr><th></th><th></th><th></th><th></th><th data-hidden data-card-cover data-type="files"></th></tr></thead><tbody><tr><td><h4><i class="fa-github">:github:</i></h4></td><td><strong>GitHub</strong></td><td>mqBase is 100% open source and built by developers just like you. Head to our GitHub repository to learn how to submit your first PR.</td><td><a href="https://www.gitbook.com/" class="button secondary">Submit a PR</a></td><td></td></tr></tbody></table>
