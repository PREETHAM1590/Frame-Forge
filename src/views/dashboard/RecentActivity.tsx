import { Activity as ActivityIcon } from "lucide-react";
import {
  Badge,
  Empty,
  LinkButton,
  SectionHeader,
  formatTime,
  statusTone,
} from "../../components/ui";
import type { Activity } from "../../../shared/contracts";

export function RecentActivity({
  activity,
  onViewAll,
}: {
  activity: Activity[];
  onViewAll: () => void;
}) {
  return (
    <section className="dash-card">
      <SectionHeader
        title="Recent activity"
        aside={<LinkButton onClick={onViewAll}>View all</LinkButton>}
      />
      {activity.length ? (
        <div className="recent-list stagger">
          {activity.slice(0, 4).map((a) => (
            <div key={a.id}>
              <ActivityIcon size={17} />
              <div>
                <strong>{a.label}</strong>
                <p className="muted">{formatTime(a.at)}</p>
              </div>
              <Badge tone={statusTone(a.status)}>{a.status}</Badge>
            </div>
          ))}
        </div>
      ) : (
        <Empty
          title="A clean starting point"
          description="Your operations and configuration changes will appear here."
        />
      )}
    </section>
  );
}
