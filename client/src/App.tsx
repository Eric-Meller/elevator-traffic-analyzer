import { Router, Route, Switch } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import ElevatorCalculator from "./pages/ElevatorCalculator";

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router hook={useHashLocation}>
        <Switch>
          <Route path="/" component={ElevatorCalculator} />
          <Route>
            <ElevatorCalculator />
          </Route>
        </Switch>
      </Router>
      <Toaster />
    </QueryClientProvider>
  );
}

export default App;
