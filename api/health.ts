export default function handler(_req: any, res: any) {
  res.status(200).json({
    status: 'ok',
    time: new Date().toISOString(),
    service: 'admin-backend',
  });
}
