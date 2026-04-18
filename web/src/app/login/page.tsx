"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/components/auth-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function LoginPage() {
  const { user, loading, signIn } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && user) router.replace("/");
  }, [user, loading, router]);

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>vc-tower</CardTitle>
          <CardDescription>Sign in to view and enrich investor rows.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            className="w-full"
            onClick={signIn}
            disabled={loading}
          >
            {loading ? "Loading…" : "Sign in with Google"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
