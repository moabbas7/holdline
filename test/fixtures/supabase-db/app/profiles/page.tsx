export default async function ProfilesPage() {
  const res = await fetch('/api/profiles');
  const profiles: { email: string }[] = await res.json();
  return <ul>{profiles.map((p) => <li key={p.email}>{p.email}</li>)}</ul>;
}
