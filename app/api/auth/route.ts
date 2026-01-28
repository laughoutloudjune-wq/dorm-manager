import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export async function POST(req: NextRequest) {
  const body = await req.json();
  
  if (body.password === process.env.ADMIN_PASSWORD) {
    // FIX: We must "await" the cookies() function now
    const cookieStore = await cookies();
    
    cookieStore.set('admin_session', 'true', { 
        httpOnly: true, 
        path: '/',
        maxAge: 60 * 60 * 24 * 7 
    });
    return NextResponse.json({ success: true });
  }
  
  return NextResponse.json({ success: false }, { status: 401 });
}