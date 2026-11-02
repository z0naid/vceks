export default function HomePage() {
  return (
    <main>
      <h1>securly-tool-template</h1>
      <p>
        A private tool behind an Application Load Balancer that requires OpenID Connect
        authentication. If you can read this over HTTPS, the load balancer authenticated you.
      </p>
      <ul>
        <li>
          <a href="/whoami">Who am I</a> &mdash; the verified identity the load balancer passed in.
        </li>
        <li>
          <a href="/api/health">/api/health</a> &mdash; unauthenticated liveness probe used by the
          target group health check.
        </li>
      </ul>
    </main>
  );
}
