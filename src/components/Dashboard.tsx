"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Plus,
  Trash2,
  Pencil,
  Calendar as CalendarIcon,
  ChevronRight,
  ChevronDown,
  LogOut,
  MoreVertical,
  Settings2
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { format } from "date-fns";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";

type Item = {
  id: string;
  name: string;
  note: string | null;
  badge: string | null;
  checked: boolean;
};

type Section = {
  id: string;
  title: string;
  icon: string;
  items: Item[];
};

type Countdown = {
  id: number;
  title: string;
  date: string;
};

export default function Dashboard() {
  const [sections, setSections] = useState<Section[]>([]);
  const [countdown, setCountdown] = useState<Countdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [timeLeft, setTimeLeft] = useState<{ days: number, hours: number, minutes: number, seconds: number } | null>(null);

  // For editing countdown
  const [isEditingCountdown, setIsEditingCountdown] = useState(false);
  const [newCountdownTitle, setNewCountdownTitle] = useState("");
  const [newCountdownDate, setNewCountdownDate] = useState<Date | undefined>(new Date());

  // For editing sections/items
  const [isAddingSection, setIsAddingSection] = useState(false);
  const [newSectionTitle, setNewSectionTitle] = useState("");
  const [newSectionIcon, setNewSectionIcon] = useState("📋");

  const [addingItemTo, setAddingItemTo] = useState<string | null>(null);
  const [newItemName, setNewItemName] = useState("");
  const [newItemNote, setNewItemNote] = useState("");
  const [newItemBadge, setNewItemBadge] = useState("");

  const accentColor = "#E8500A";

  useEffect(() => {
    fetchData();
  }, []);

  async function fetchData() {
    try {
      const res = await fetch("/api/todo");
      const data = await res.json();
      setSections(data.sections);
      setCountdown(data.countdown);
      setNewCountdownTitle(data.countdown?.title || "");
      setNewCountdownDate(data.countdown?.date ? new Date(data.countdown.date) : new Date());
      setLoading(false);
    } catch (err) {
      console.error("Failed to fetch data", err);
    }
  }

  useEffect(() => {
    if (!countdown) return;

    const calculateTimeLeft = () => {
      const now = new Date().getTime();
      const target = new Date(countdown.date).getTime();
      const diff = target - now;

      if (diff <= 0) {
        setTimeLeft({ days: 0, hours: 0, minutes: 0, seconds: 0 });
        return false;
      } else {
        setTimeLeft({
          days: Math.floor(diff / (1000 * 60 * 60 * 24)),
          hours: Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)),
          minutes: Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)),
          seconds: Math.floor((diff % (1000 * 60)) / 1000),
        });
        return true;
      }
    };

    calculateTimeLeft();
    const timer = setInterval(() => {
      if (!calculateTimeLeft()) {
        clearInterval(timer);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [countdown]);

  const totalItems = sections.flatMap(s => s.items).length;
  const checkedItems = sections.flatMap(s => s.items).filter(i => i.checked).length;
  const progress = totalItems > 0 ? Math.round((checkedItems / totalItems) * 100) : 0;

  async function toggleItem(itemId: string, checked: boolean) {
    try {
      await fetch(`/api/todo/items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checked }),
      });
      setSections(prev => prev.map(s => ({
        ...s,
        items: s.items.map(i => i.id === itemId ? { ...i, checked } : i)
      })));
    } catch (err) {
      console.error(err);
    }
  }

  async function deleteItem(sectionId: string, itemId: string) {
    try {
      await fetch(`/api/todo/items/${itemId}`, { method: "DELETE" });
      setSections(prev => prev.map(s => s.id === sectionId ? {
        ...s,
        items: s.items.filter(i => i.id !== itemId)
      } : s));
    } catch (err) {
      console.error(err);
    }
  }

  async function addItem(sectionId: string) {
    if (!newItemName.trim()) return;
    try {
      const res = await fetch("/api/todo/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sectionId,
          name: newItemName,
          note: newItemNote,
          badge: newItemBadge,
        }),
      });
      const newItem = await res.json();
      setSections(prev => prev.map(s => s.id === sectionId ? {
        ...s,
        items: [...s.items, newItem]
      } : s));
      setAddingItemTo(null);
      setNewItemName("");
      setNewItemNote("");
      setNewItemBadge("");
    } catch (err) {
      console.error(err);
    }
  }

  async function addSection() {
    if (!newSectionTitle.trim()) return;
    try {
      const res = await fetch("/api/todo/sections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newSectionTitle,
          icon: newSectionIcon,
        }),
      });
      const newSection = await res.json();
      setSections(prev => [...prev, { ...newSection, items: [] }]);
      setIsAddingSection(false);
      setNewSectionTitle("");
    } catch (err) {
      console.error(err);
    }
  }

  async function deleteSection(sectionId: string) {
    if (!confirm("Are you sure you want to delete this section and all its items?")) return;
    try {
      await fetch(`/api/todo/sections/${sectionId}`, { method: "DELETE" });
      setSections(prev => prev.filter(s => s.id !== sectionId));
    } catch (err) {
      console.error(err);
    }
  }

  async function updateCountdown() {
    if (!newCountdownTitle.trim() || !newCountdownDate) return;
    try {
      const res = await fetch("/api/todo/countdown", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newCountdownTitle,
          date: newCountdownDate.toISOString(),
        }),
      });
      const updated = await res.json();
      setCountdown(updated);
      setIsEditingCountdown(false);
    } catch (err) {
      console.error(err);
    }
  }

  async function handleLogout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.reload();
  }

  if (loading) return <div className="flex items-center justify-center h-screen text-muted-foreground">Loading...</div>;

  return (
    <div className="max-w-2xl mx-auto p-4 md:p-8 font-sans pb-20">
      <div className="flex justify-between items-start mb-8">
        <div className="flex items-center gap-4">
          <div className="bg-primary/5 p-4 rounded-xl border border-primary/10">
            {timeLeft && (
              <div className="flex gap-3 text-center">
                <div>
                  <div className="text-2xl font-bold">{timeLeft.days}</div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Days</div>
                </div>
                <div className="text-2xl font-light text-muted-foreground/30">:</div>
                <div>
                  <div className="text-2xl font-bold">{timeLeft.hours}</div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Hours</div>
                </div>
                <div className="text-2xl font-light text-muted-foreground/30">:</div>
                <div>
                  <div className="text-2xl font-bold">{timeLeft.minutes}</div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Min</div>
                </div>
              </div>
            )}
            <div className="mt-2 flex items-center gap-2">
              <span className="text-sm font-semibold text-primary uppercase tracking-tight">{countdown?.title}</span>
              <Dialog open={isEditingCountdown} onOpenChange={setIsEditingCountdown}>
                <DialogTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-6 w-6 rounded-full hover:bg-primary/10 hover:text-primary">
                    <Pencil className="h-3 w-3" />
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Edit Countdown</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4 py-4">
                    <div className="space-y-2">
                      <Label>Title</Label>
                      <Input value={newCountdownTitle} onChange={e => setNewCountdownTitle(e.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label>Date</Label>
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button variant="outline" className="w-full justify-start text-left font-normal">
                            <CalendarIcon className="mr-2 h-4 w-4" />
                            {newCountdownDate ? format(newCountdownDate, "PPP") : <span>Pick a date</span>}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0">
                          <Calendar
                            mode="single"
                            selected={newCountdownDate}
                            onSelect={setNewCountdownDate}
                          />
                        </PopoverContent>
                      </Popover>
                    </div>
                  </div>
                  <DialogFooter>
                    <Button onClick={updateCountdown}>Save Changes</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </div>

        <div className="text-right">
          <div className="text-4xl font-black text-primary mb-1">{progress}%</div>
          <Button variant="ghost" size="sm" onClick={handleLogout} className="text-muted-foreground hover:text-destructive">
            <LogOut className="h-4 w-4 mr-2" /> Logout
          </Button>
        </div>
      </div>

      <div className="space-y-2 mb-8">
        <Progress value={progress} className="h-2" />
        <div className="flex justify-between text-xs text-muted-foreground font-medium">
          <span>{checkedItems} of {totalItems} items completed</span>
          <Button
             variant="ghost"
             size="sm"
             className="h-auto p-0 text-muted-foreground hover:bg-transparent hover:text-primary"
             onClick={async () => {
                if(!confirm("Reset all items?")) return;
                await fetch("/api/todo/reset", { method: "POST" });
                fetchData();
             }}
          >
            ↺ Reset All
          </Button>
        </div>
      </div>

      <div className="space-y-10">
        {sections.map(section => (
          <div key={section.id} className="group">
            <div className="flex items-center justify-between border-b pb-2 mb-4">
              <div className="flex items-center gap-2">
                <span className="text-xl">{section.icon}</span>
                <h3 className="text-sm font-bold uppercase tracking-widest text-foreground/80">{section.title}</h3>
                <Badge variant="secondary" className="text-[10px] px-1.5 h-4 ml-2">
                  {section.items.filter(i => i.checked).length}/{section.items.length}
                </Badge>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity">
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem className="text-destructive" onClick={() => deleteSection(section.id)}>
                    <Trash2 className="h-4 w-4 mr-2" /> Delete Section
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className="space-y-1">
              {section.items.map(item => (
                <div
                  key={item.id}
                  className={`flex items-start gap-3 p-2 rounded-lg transition-colors group/item ${item.checked ? 'opacity-50' : 'hover:bg-muted/50'}`}
                >
                  <Checkbox
                    checked={item.checked}
                    onCheckedChange={(checked) => toggleItem(item.id, checked as boolean)}
                    className="mt-1"
                  />
                  <div className="flex-1 min-w-0" onClick={() => toggleItem(item.id, !item.checked)}>
                    <div className={`text-sm font-semibold leading-tight ${item.checked ? 'line-through' : ''}`}>
                      {item.name}
                    </div>
                    {item.note && <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{item.note}</p>}
                    {item.badge === "warn" && (
                      <Badge variant="outline" className="mt-2 bg-yellow-50 text-yellow-700 border-yellow-200 text-[10px]">
                        ⚠ Attention
                      </Badge>
                    )}
                    {item.badge === "tip" && (
                      <Badge variant="outline" className="mt-2 bg-blue-50 text-blue-700 border-blue-200 text-[10px]">
                        + Recommendation
                      </Badge>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 opacity-0 group-item/item:hover:opacity-100 text-muted-foreground hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteItem(section.id, item.id);
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}

              {addingItemTo === section.id ? (
                <Card className="mt-4 border-dashed bg-muted/30">
                  <CardContent className="p-4 space-y-4">
                    <Input
                      placeholder="Item name..."
                      value={newItemName}
                      onChange={e => setNewItemName(e.target.value)}
                      autoFocus
                    />
                    <Input
                      placeholder="Note (optional)..."
                      value={newItemNote}
                      onChange={e => setNewItemNote(e.target.value)}
                    />
                    <div className="flex gap-2">
                       <Button size="sm" onClick={() => addItem(section.id)}>Add Item</Button>
                       <Button size="sm" variant="ghost" onClick={() => setAddingItemTo(null)}>Cancel</Button>
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start text-muted-foreground hover:text-primary mt-2 h-8"
                  onClick={() => setAddingItemTo(section.id)}
                >
                  <Plus className="h-4 w-4 mr-2" /> Add Item
                </Button>
              )}
            </div>
          </div>
        ))}

        <div className="pt-8 flex justify-center">
          <Dialog open={isAddingSection} onOpenChange={setIsAddingSection}>
            <DialogTrigger asChild>
              <Button variant="outline" className="rounded-full px-8">
                <Plus className="h-4 w-4 mr-2" /> New Section
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add New Section</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="space-y-2">
                  <Label>Icon (Emoji)</Label>
                  <Input value={newSectionIcon} onChange={e => setNewSectionIcon(e.target.value)} maxLength={2} className="w-20 text-center" />
                </div>
                <div className="space-y-2">
                  <Label>Section Title</Label>
                  <Input value={newSectionTitle} onChange={e => setNewSectionTitle(e.target.value)} placeholder="e.g. Tools, Electronics..." />
                </div>
              </div>
              <DialogFooter>
                <Button onClick={addSection}>Create Section</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}
