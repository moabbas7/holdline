export default async function UserPage({ params }: { params: { id: string } }) {
  const res = await fetch(`/api/users/${params.id}`);
  const data = await res.json();
  const city = data.user.address.city;
  return <p>{data.user.name} lives in {city}</p>;
}
