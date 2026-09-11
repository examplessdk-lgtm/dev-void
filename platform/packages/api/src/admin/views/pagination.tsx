export function Pagination({
  page,
  totalPages,
  baseUrl,
}: {
  page: number;
  totalPages: number;
  baseUrl: string;
}) {
  if (totalPages <= 1) {
    return <></>;
  }
  return (
    <p style="margin-top: 10px">
      {page > 1 ? <a href={`${baseUrl}?page=${page - 1}`}>Previous</a> : <>Previous</>}
      {' | '}
      {page} / {totalPages}
      {' | '}
      {page < totalPages ? <a href={`${baseUrl}?page=${page + 1}`}>Next</a> : <>Next</>}
    </p>
  );
}
